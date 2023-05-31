import { Context, Probot, ProbotOctokit } from "probot";
import { PullRequest } from "@octokit/webhooks-types";
import { parseDotGitmodulesContent } from "./submodule-parser";
import { BotState, SubmoduleInfo, CommitStatus, defaultCommitStatus } from "./types";
import assert from "assert";
import { ExecException } from "child_process";


class UpdateBot {
  state: BotState;
  currentUpdatePRID: number;
  updatePR: PullRequest | null;
  submoduleInfo: Map<string, SubmoduleInfo>;
  installationId: number;

  constructor() {
    this.state = BotState.IDLE;
    this.currentUpdatePRID = -1;
    this.updatePR = null;
    this.submoduleInfo = new Map;
    this.installationId = -1;
  }

  async checksCompleted(context: Context, PRNumber: number) : Promise<boolean> {
    let PR = context.repo({pull_number: PRNumber});
    let {data: PRInfo} = await context.octokit.pulls.get(PR);
    let repoWithRef = context.repo({ref: PRInfo.head.sha});
    let checks = await context.octokit.checks.listForRef(repoWithRef);
    for (let checkRun of checks.data.check_runs) {
      if (checkRun.status !== "completed") {
        return false;
      }
    }
    return true;
  }

  async checksPassed(context: Context, PRNumber: number) : Promise<boolean> {
    let PR = context.repo({pull_number: PRNumber});
    let {data: PRInfo} = await context.octokit.pulls.get(PR);
    let repoWithRef = context.repo({ref: PRInfo.head.sha});
    let checks = await context.octokit.checks.listForRef(repoWithRef);
    for (let checkRun of checks.data.check_runs) {
      if (!(checkRun.conclusion === "success" || checkRun.conclusion === "skipped")) {
        return false;
      }
    }
    return true;
  }

  async checksReady(context: Context, PRNumber: number) : Promise<boolean> {
    let passed = await this.checksPassed(context, PRNumber);
    let PR = context.repo({pull_number: PRNumber});
    let {data: PRInfo} = await context.octokit.pulls.get(PR);
    let {data: combinedStatus} = await context.octokit.repos.getCombinedStatusForRef(context.repo({ref: PRInfo.head.sha}));
    let {data: statuses} = await context.octokit.repos.listCommitStatusesForRef(context.repo({ref: PRInfo.head.sha}));
    if (statuses.length !== 0) {
      let statusReady = (combinedStatus.state === "success");
      return passed && statusReady;
    } else {
      return passed;
    }
  }

  async PRApproved(context: Context, PRNumber: number) : Promise<boolean> {
    let PR = context.repo({pull_number: PRNumber});
    let {data: PRInfo} = await context.octokit.pulls.get(PR);
    let baseRef = PRInfo.base.ref;
    // Get all pull request reviews for a PR
    let {data: reviews} = await context.octokit.pulls.listReviews(PR);
    let findReviewByUser = (user: string) => {
      for (let review of reviews) {
        if (review.user?.login === user) {
          return review;
        }
      }
      return null;
    }
    // Get pull request review protection rules
    try {
      let {data: reviewProtection} = await context.octokit.repos.getPullRequestReviewProtection(context.repo({branch: baseRef}));
      if (reviewProtection.require_code_owner_reviews) {
        let codeOwnerReview = findReviewByUser(PR.owner);
        if (codeOwnerReview === null || codeOwnerReview.state !== "APPROVED") {
          return false;
        }
      }
      if (reviewProtection.required_approving_review_count && reviewProtection.required_approving_review_count > 0) {
        let approvedReviews = 0;
        let reviewUsers = [];
        let approvalUsers = [];
        for (let review of reviews) {
          let user = review.user?.login;
          if (user === undefined) {
            continue;
          }
          reviewUsers.push(user);
          let {status: collaboratorStatus} = await context.octokit.repos.checkCollaborator(context.repo({username: user}) as any);
          if (collaboratorStatus == 204 && review.state === "APPROVED") {
            approvedReviews++;
            approvalUsers.push(user);
          }
        }
        context.log.info(`Review users: ${reviewUsers}. Approval users: ${approvalUsers}.`);
        if (approvedReviews < reviewProtection.required_approving_review_count) {
          return false;
        } else {
          return true;
        }
      }
      return true;
    } catch (e: any) {
      context.log.warn((e as ExecException).name);
      return false;
    }
  }

  submodulesReady() : boolean {
    let states = Array.from(this.submoduleInfo.values(), (info, _)=> {
      return info.commit_status.state === "success";
    });
    return states.find(value => value === false) === undefined;
  }

  async logUpdate(app: Probot) {
    let allMerged = await this.handleSubmodulePRs(app);
    if(allMerged) {
      this.updateSubmodules(app);
      bot.state = BotState.IDLE;
    }
  }

  async handleSubmodulePRs(app: Probot) : Promise<boolean> {
    // Make sure bot.submoduleInfo consists to submodules got from dtk
    const octokit = await app.auth(this.installationId);
    let submodules = Array.from(this.submoduleInfo.values());
    for (let submodule of submodules) {
      // approve every PR
      try {
        await octokit.pulls.createReview({
          owner: submodule.owner,
          repo: submodule.repo,
          pull_number: submodule.commit_status.pull_number,
          event: "APPROVE"
        });
      } catch (e: any) {
        app.log.error(e);
        return false;
      }
    }
    let allMerged = true;
    for (let submodule of submodules) {
      // merge every PR
      try {
        let {data: commit} = await octokit.pulls.merge({
          owner: submodule.owner,
          repo: submodule.repo,
          pull_number: submodule.commit_status.pull_number,
          merge_method: "rebase"
        });
        submodule.merged_sha = commit.sha;
      } catch (e: any) {
        // This operation should be atom, or we schedule a task to complete it soon.
        // In case we lost a packet or the network is down suddenly.
        allMerged = false;
        app.log.error(e);
      }
    }
    return allMerged;
  }

  async updateSubmodules(app: Probot) {
    const octokit = await app.auth(this.installationId);
    app.log.info("Start updating submodules for dtk...");
    let tree : {
      path: string;
      mode: "160000" | "100644" | "100755" | "040000" | "120000";
      type: "commit" | "tree" | "blob";
      sha: string;
    }[] = [];
    this.submoduleInfo.forEach((info, repo) => {
      tree.push({
        path: repo,
        mode: "160000",
        type: "commit",
        sha: info.merged_sha
      });
    });
    assert(this.updatePR !== null);
    const {data: newTree} = await octokit.rest.git.createTree({
      owner: this.updatePR.base.user.login,
      repo: "dtk",
      tree: tree,
      base_tree: this.updatePR.base.sha
    });
    const {data: newCommit} = await octokit.rest.git.createCommit({
      owner: this.updatePR.base.user.login,
      repo: "dtk",
      message: 'chore: sync repo modules',
      tree: newTree.sha,
      parents: [this.updatePR.base.sha]
    });
    // update reference
    const result = await octokit.rest.git.updateRef({
      owner: this.updatePR.base.user.login,
      repo: "dtk",
      ref: `heads/${this.updatePR.base.ref}`,
      sha: newCommit.sha,
      force: true
    });
    app.log.info(result);
    const mergedPR = octokit.pulls.merge({
      owner: this.updatePR.base.user.login,
      repo: "dtk",
      pull_number: this.currentUpdatePRID,
      merge_method: "rebase"
    })
    app.log.info(mergedPR);
  }
};

// Global update bot
let bot: UpdateBot = new UpdateBot();

async function handleEmptyChecks(octokit: InstanceType<typeof ProbotOctokit>, submoduleInfo: SubmoduleInfo) {
  return new Promise<Awaited<ReturnType<typeof octokit.repos.createCommitStatus>>> ((resolve, reject) =>
    setTimeout(async () => {
      let {data: checks} = await octokit.checks.listForRef({
        owner: submoduleInfo.owner,
        repo: submoduleInfo.repo,
        ref: submoduleInfo.commit_status.pull_sha
      });
      // TODO What about the commit statuses?
      octokit.log.info(`Checks count for ${submoduleInfo.repo}: ${checks.total_count}`);
      if (checks.total_count === 0 && bot.updatePR !== null) {
        let result = await octokit.repos.createCommitStatus({
          owner: submoduleInfo.owner,
          repo: "dtk",
          sha: bot.updatePR.head.sha,
          state: "success",
          context: submoduleInfo.commit_status.context,
          target_url: submoduleInfo.commit_status.pull_url
        });
        if (result.status === 201) {
          submoduleInfo.commit_status.state = "success";
          resolve(result);
        } else {
          reject(result);
        }
      }
    }, 10000));
}

async function parseCommitStatus(context: Context<"status">) : Promise<CommitStatus | null> {
  context.log.info(`Status ${context.payload.context} -- ${context.payload.state} for ${context.payload.sha} in ${context.payload.repository.name}`);
  const contextPattern = /auto-update\s\/\scheck-update\s\((?<repo>\w+)\)/g;
  let match = contextPattern.exec(context.payload.context);
  if (match !== null && match.groups !== undefined) {
    if(context.payload.target_url !== null) {
      const urlPattern = /\w+\/pull\/(?<number>\d+)/;
      let urlMatch = urlPattern.exec(context.payload.target_url);
      if (urlMatch !== null && urlMatch.groups !== undefined) {
        let pullNumber = parseInt(urlMatch.groups.number);
        context.log.info(`Extracted update PR ${context.payload.target_url} from status ${context.payload.name} for repo ${match.groups.repo}.`);
        let {data: PRInfo} = await context.octokit.pulls.get({
          owner: context.payload.repository.owner.login,
          repo: match.groups.repo,
          pull_number: pullNumber
        });
        let status : CommitStatus = {
          repo: match.groups.repo,
          context: context.payload.context,
          description: context.payload.description,
          state: context.payload.state,
          pull_number: pullNumber,
          pull_sha: PRInfo.head.sha,
          pull_url: context.payload.target_url
        };
        return status;
      }
    } else {
      context.log.warn(`Target URL for status ${context.payload.context} cannot be null.`);
    }
  }
  return null;
}

export = (app: Probot) => {
  app.on(["pull_request.opened", "pull_request.reopened", "pull_request.synchronize"], async (context) => {
    if (context.payload.repository.name === "dtk") {
      bot.state = BotState.UPDATING;
      if (context.payload.installation === undefined) {
        return;
      }
      bot.installationId = context.payload.installation.id;
      bot.currentUpdatePRID = context.payload.number;
      bot.updatePR = context.payload.pull_request;
      // Just build submodule info at this time to ensure submoduleInfo track is correct
      let {data: gitmodules} = await context.octokit.repos.getContent(context.repo({path: ".gitmodules"}));
      if ("content" in gitmodules) {
        let gitmodulesContent = Buffer.from(gitmodules.content, gitmodules.encoding as BufferEncoding).toString();
        let submodules = parseDotGitmodulesContent(gitmodulesContent);
        for (let submodule of submodules) {
          let info: SubmoduleInfo = {
            owner: context.payload.repository.owner.login,
            repo: submodule.name,
            repo_url: submodule.url,
            branch: submodule.branch,
            merged_sha: "",
            complete: false,
            commit_status: defaultCommitStatus
          };
          bot.submoduleInfo.set(submodule.name, info);
        }
      } else {
        context.log.error("gitmodules is a file, response must contain property content.");
      }
      context.log.info(`PR for repo ${context.payload.repository.name} ${context.payload.action}. Number: ${context.payload.number}. URL: ${context.payload.pull_request.html_url}.`);
    }
  });

  app.on("pull_request_review.submitted", async (context) => {
    context.log.info(`PR review for repo ${context.payload.repository.name} was submitted by ${context.payload.review.user.login}. Number: ${context.payload.pull_request.number}. URL: ${context.payload.pull_request.url}.`);
    let approved = await bot.PRApproved(context, context.payload.pull_request.number);
    context.log.info(`PR approved: ${approved}`);
    if (context.payload.pull_request.number === bot.currentUpdatePRID && approved) {
      let checksPassed = await bot.checksPassed(context, bot.currentUpdatePRID);
      if(checksPassed && bot.submodulesReady()) {
        bot.logUpdate(app);
      }
    }
  });

  app.on("check_run.completed", async (context) => {
    context.log.info(`Check run -- ${context.payload.check_run.name} -- completed`);
    let associatedPRCount = context.payload.check_run.pull_requests.length;
    if (associatedPRCount === 0) {
      // Only process checks associated with PRs
      return;
    }
    context.log.info(`PR: ${context.payload.check_run.pull_requests[0].url}`);
    let completed = await bot.checksCompleted(context, context.payload.check_run.pull_requests[0].number);
    if (completed) {
      context.log.info(`All checks completed for ${context.payload.check_run.pull_requests[0].url}.`);
      // Update commit status to success
      let repo = context.payload.repository.name;
      let updatePR = bot.submoduleInfo.get(repo);
      let state : "error" | "failure" | "pending" | "success" = "pending";
      if (updatePR !== undefined) {
        let ready = await bot.checksReady(context, updatePR.commit_status.pull_number);
        if (ready) {
          state = "success";
        } else {
          state = "failure";
        }
        context.log.info(`Updating commit status ${updatePR.commit_status.context} to ${state}.`);
        if (bot.updatePR !== null) {
          let result = await context.octokit.repos.createCommitStatus({
            owner: context.payload.repository.owner.login,
            repo: "dtk",
            sha: bot.updatePR.head.sha,
            state: state,
            context: updatePR.commit_status.context,
            target_url: updatePR.commit_status.pull_url
          });
          if (result.status === 201) {
            updatePR.commit_status.state = "success";
          }
        }
      }
      // Check if this PR is the update PR for dtk
      if (context.payload.check_run.pull_requests[0].number === bot.currentUpdatePRID && state === "success") {
        // All checks and commit statuses are ready for update PR, we should check if this PR is approved.
        let approved = await bot.PRApproved(context, bot.currentUpdatePRID);
        let checksPassed = await bot.checksPassed(context, bot.currentUpdatePRID);
        context.log.info(`Update PR approved: ${approved}`);
        if (approved && checksPassed && bot.submodulesReady()) {
          bot.logUpdate(app);
        }
      }
    }
  });

  app.on("status", async (context) => {
    let status = await parseCommitStatus(context);
    if (status !== null && bot.state === BotState.UPDATING) {
      let info = bot.submoduleInfo.get(status.repo);
      if (info !== undefined) {
        info.commit_status = status;
      } else {
        context.log.warn(`Receive a submodule update status -- ${context.payload.context} -- but do not have track info.`)
        return;
      }
      if(status.state === "success") {
        let checksPassed = await bot.checksPassed(context, bot.currentUpdatePRID);
        let approved = await bot.PRApproved(context, bot.currentUpdatePRID);
        if (bot.submodulesReady() && checksPassed && approved) {
          bot.logUpdate(app);
        }
        return;
      } else if(status.state === "pending") {
        // List workflows for this repo, if there aren't any, then we assume checks are passed
        // Note that this is insufficient but required. GitHub will return an empty array if there
        // are no files under .github/workflows or GitHub Actions is not enabled for the repo.
        // The more accurate way is to detect if there are any checks for this PR. However, there will
        // be some delay between checks starting and the status event being fired. We may get a wrong result.
        // Just use a timer to handle this
        handleEmptyChecks(context.octokit, info).catch((err) => {
          context.log.error(err);
        });
      }
    }
  });
};
