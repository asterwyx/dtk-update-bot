import { Context, Probot, ProbotOctokit } from "probot";
import { PullRequest } from "@octokit/webhooks-types";
import { parseDotGitmodulesContent, Submodule } from "./submodule-parser";
import { BotState, SubmoduleInfo, CommitStatus, defaultCommitStatus } from "./types";
import assert from "assert";
import { ExecException, execSync } from "child_process";
import { mkdtempSync, rm } from "fs";
import { chdir } from "process";
import { tmpdir } from "os";
class UpdateBot {
  state: BotState;
  currentUpdatePRID: number;
  updatePR: PullRequest | null;
  submoduleInfo: Map<string, SubmoduleInfo>;
  installationId: number;
  updateToVersion: string | null;
  updateBase: string;
  authorLogin: string;
  authorEmail: string;
  workDir: string | null;

  constructor() {
    this.state = BotState.IDLE;
    this.currentUpdatePRID = -1;
    this.updatePR = null;
    this.submoduleInfo = new Map;
    this.installationId = -1;
    this.updateToVersion = null;
    this.updateBase = "";
    this.authorEmail = "";
    this.authorLogin = "";
    this.workDir = null;
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
    const reviewsRes = context.octokit.pulls.listReviews(PR);
    let {data: PRInfo} = await context.octokit.pulls.get(PR);
    let baseRef = PRInfo.base.ref;
    let reviewProtection : Awaited<ReturnType<typeof context.octokit.repos.getPullRequestReviewProtection>>;
    try {
      reviewProtection = await context.octokit.repos.getPullRequestReviewProtection(context.repo({branch: baseRef}));
    } catch (error : any) {
      let e = error as ExecException;
      context.log.info(e);
      return true;
    }
    const {data: reviews} = await reviewsRes;
    if (reviewProtection.data.require_code_owner_reviews) {
      const found = reviews.find((review) => review.user?.login === PR.owner && review.state === "APPROVED");
      if (found === undefined) {
        return false;
      }
    }
    if (reviewProtection.data.required_approving_review_count && reviewProtection.data.required_approving_review_count > 0) {
      let approvedReviews = 0;
      let reviewUsers = [];
      let approvalUsers = [];
      for (let review of reviews) {
        let user = review.user?.login;
        if (user === undefined) {
          continue;
        }
        reviewUsers.push(user);
        try {
          let {status: collaboratorStatus} = await context.octokit.repos.checkCollaborator(context.repo({username: user}));
          if (collaboratorStatus == 204 && review.state === "APPROVED") {
            approvedReviews++;
            approvalUsers.push(user);
          }
        } catch(_) {
          return false;
        }
      }
      context.log.info(`Review users: ${reviewUsers}. Approval users: ${approvalUsers}.`);
      if (approvedReviews < reviewProtection.data.required_approving_review_count) {
        return false;
      } else {
        return true;
      }
    }
    return true;
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
    let allMerged = true;
    let promises : ReturnType<typeof octokit.pulls.merge>[] = [];
    submodules.forEach((submodule) => {
      let mergePromise = octokit.pulls.merge({
        owner: submodule.owner,
        repo: submodule.repo,
        pull_number: submodule.commit_status.pull_number,
        merge_method: "rebase"
      });
      mergePromise.then((commit) => {
        submodule.merged_sha = commit.data.sha;
      }).catch(e => {
        // This operation should be atom, or we schedule a task to complete it soon.
        // In case we lost a packet or the network is down suddenly.
        app.log.error(e);
      })
      promises.push(mergePromise);
    });
    await Promise.all(promises).catch(_ => {
      allMerged = false;
    });
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
      message: "chore: sync repo modules",
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
    await octokit.repos.createCommitStatus({
      owner: this.updatePR.base.user.login,
      repo: "dtk",
      sha: this.updatePR.head.sha,
      state: "success",
      context: "auto-update / update-submodules",
      description: "Submodules updated successfully"
    })
    const mergedPR = octokit.pulls.merge({
      owner: this.updatePR.base.user.login,
      repo: "dtk",
      pull_number: this.currentUpdatePRID,
      merge_method: "rebase"
    })
    app.log.info(mergedPR);
  }

  async generateChangelog(submodule: Submodule): Promise<string> {
    if(!bot.workDir) {
      bot.workDir = mkdtempSync(`${tmpdir()}/dtk-update-bot-`);
    }
    chdir(bot.workDir);
    execSync(`git clone -b ${submodule.branch} ${submodule.url} ${submodule.path}`);
    chdir(submodule.path);
    execSync(`git config user.name "${bot.authorLogin}"`);
    execSync(`git config user.email "${bot.authorEmail}"`);
    execSync(`gbp deepin-changelog --spawn-editor=never --distribution=unstable --force-distribution --git-author --ignore-branch -N ${bot.updateToVersion}`);
    return execSync("cat debian/changelog").toString();
  }

  async deliverUpdatePR(context: Context<"pull_request">, submodule: Submodule) {
    let info: SubmoduleInfo = {
      owner: context.payload.repository.owner.login,
      repo: submodule.name,
      repo_url: submodule.url,
      branch: submodule.branch,
      merged_sha: "",
      commit_status: defaultCommitStatus,
      started_at: new Date()
    };
    context.octokit.repos.createCommitStatus({
      owner: info.owner,
      repo: "dtk",
      sha: context.payload.pull_request.head.sha,
      state: "pending",
      context: `auto-update / check-update (${info.repo})`,
      target_url: info.repo_url,
      description: "Creating pull request for update..."
    });
    const topicBranch = 'topic-update';
    const commitRes = this.generateChangelog(submodule)
    .then(async (changelogContent) => {
      context.log.info(changelogContent);
      const {data: changelogBlob} = await context.octokit.git.createBlob({
        owner: info.owner,
        repo: info.repo,
        content: changelogContent,
        encoding: "utf-8"
      });
      const changelog : {
        path?: string;
        mode?: "100644" | "100755" | "040000" | "160000" | "120000";
        type?: "blob" | "tree" | "commit";
        sha?: string | null;
        content?: string;
      } = {
        path: 'debian/changelog',
        mode: '100644',
        type: 'blob',
        sha: changelogBlob.sha
      }
      const identity = {
        name: bot.authorLogin,
        email: bot.authorEmail
      };
      const {data: base} = await context.octokit.repos.getBranch({
        owner: info.owner,
        repo: info.repo,
        branch: bot.updateBase
      });
      const baseSha = base.commit.sha;
      const {data: newTree} = await context.octokit.git.createTree({
        owner: info.owner,
        repo: info.repo,
        tree: [changelog],
        base_tree: baseSha
      });
      return context.octokit.git.createCommit({
        owner: info.owner,
        repo: info.repo,
        message: `chore: update changelog\n\nRelease ${bot.updateToVersion}.`,
        tree: newTree.sha,
        parents: [baseSha],
        committer: identity,
        author: identity
      });
    });
    return context.octokit.git.listMatchingRefs({
      owner: info.owner,
      repo: info.repo,
      ref: `heads/${topicBranch}`
    }).then(async (matchedRef) => {
      const found = matchedRef.data.find(matched => matched.ref == `refs/heads/${topicBranch}`)
      const {data: newCommit} = await commitRes;
      if (found) {
        await context.octokit.git.updateRef({
          owner: info.owner,
          repo: info.repo,
          ref: `heads/${topicBranch}`,
          sha: newCommit.sha,
          force: true
        });
      } else {
        await context.octokit.git.createRef({
          owner: info.owner,
          repo: info.repo,
          ref: `heads/${topicBranch}`,
          sha: newCommit.sha
        });
      }
        // create pull request
      const {data: prs} = await context.octokit.pulls.list({
        owner: info.owner,
        repo: info.repo,
        head: `${info.owner}:${topicBranch}`,
        base: `${bot.updateBase}`
      });
      let prUrl : string;
      let prNumber : number;
      if (prs.length === 0) {
        let {data: pr} = await context.octokit.rest.pulls.create({
          owner: info.owner,
          repo: info.repo,
          title: 'chore: update changelog',
          body: `Release ${bot.updateToVersion}.`,
          head: topicBranch,
          base: bot.updateBase
        });
        prUrl = pr.html_url;
        prNumber = pr.number;
      } else {
        prUrl = prs[0].html_url;
        prNumber = prs[0].number;
      }
      // create status
      await context.octokit.repos.createCommitStatus({
        owner: info.owner,
        repo: "dtk",
        sha: context.payload.pull_request.head.sha,
        state: "pending",
        context: `auto-update / check-update (${info.repo})`,
        target_url: prUrl,
        description: "Waiting for checks to complete..."
      });
      info.commit_status.context = `auto-update / check-update (${info.repo})`;
      info.commit_status.state = "pending";
      info.commit_status.description = "Waiting for checks to complete...";
      info.commit_status.pull_sha = newCommit.sha;
      info.commit_status.pull_number = prNumber;
      info.commit_status.pull_url = prUrl;
      info.commit_status.repo = info.repo;
      // List workflows for this repo, if there aren't any, then we assume checks are passed
      // Note that this is insufficient but required. GitHub will return an empty array if there
      // are no files under .github/workflows or GitHub Actions is not enabled for the repo.
      // The more accurate way is to detect if there are any checks for this PR. However, there will
      // be some delay between checks starting and the status event being fired. We may get a wrong result.
      // Just use a timer to handle this
      handleEmptyChecks(context.octokit, info).catch((err) => {
        context.log.error(err);
      });
      bot.submoduleInfo.set(submodule.name, info);
      return info;
    });
  }
};

// Global update bot
let bot: UpdateBot = new UpdateBot();

function getDurationDescription(ms : number) {
  const durationInSeconds = ms / 1000;
  const hours = Math.floor(durationInSeconds / 3600);
  const minutes = Math.floor((durationInSeconds - hours * 3600) / 60);
  const seconds = Math.floor(durationInSeconds - hours * 3600 - minutes * 60);
  if (hours !== 0) {
    return `${hours}h${minutes}m${seconds}s`;
  } else if (minutes !== 0) {
    return `${minutes}m${seconds}s`;
  } else {
    return `${seconds}s`;
  }
}
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
          pull_url: context.payload.target_url,
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
      if (context.payload.installation === undefined) {
        return;
      }
      const {data: files} = await context.octokit.pulls.listFiles(context.pullRequest());
      const changelog = files.find(file => file.filename === "debian/changelog");
      if (changelog === undefined || changelog.patch === undefined) {
        return;
      }
      const versionPattern = /\+dtk\s\((?<version>\d+(\.\d+)*)\)/;
      const result = versionPattern.exec(changelog.patch);
      if (result === null || result.groups === undefined) {
        return;
      }
      bot.authorLogin = context.payload.pull_request.user.login;
      const {data: user} = await context.octokit.users.getByUsername({username: bot.authorLogin});
      if (user.email === null) {
        context.log.error("Author email is null!");
        return;
      }
      const startTimeRes = context.octokit.repos.createCommitStatus({
        owner: context.payload.repository.owner.login,
        repo: "dtk",
        sha: context.payload.pull_request.head.sha,
        state: "pending",
        context: "auto-update / deliver-pr",
        description: "Delivering pull requests to submodules..."
      }).then(_ => {
        return new Date();
      });
      context.octokit.repos.createCommitStatus({
        owner: context.payload.repository.owner.login,
        repo: "dtk",
        sha: context.payload.pull_request.head.sha,
        state: "pending",
        context: "auto-update / update-submodules",
        description: "Waiting for submodules to be updated..."
      })
      bot.authorEmail = user.email;
      bot.updateToVersion = result.groups.version;
      bot.state = BotState.UPDATING;
      bot.updateBase = context.payload.pull_request.base.ref;
      bot.installationId = context.payload.installation.id; // save installation id for later use
      bot.currentUpdatePRID = context.payload.number;
      bot.updatePR = context.payload.pull_request;
      // Just build submodule info at this time to ensure submoduleInfo track is correct
      let {data: gitmodules} = await context.octokit.repos.getContent(context.repo({path: ".gitmodules"}));
      if ("content" in gitmodules) {
        let gitmodulesContent = Buffer.from(gitmodules.content, gitmodules.encoding as BufferEncoding).toString();
        let submodules = parseDotGitmodulesContent(gitmodulesContent);
        let delivers : ReturnType<typeof bot.deliverUpdatePR>[] = new Array();
        for (let submodule of submodules) {
          delivers.push(bot.deliverUpdatePR(context, submodule));
        }
        const updateDeliverStatus = async (context: Context<"pull_request">) => {
          await Promise.all(delivers);
          const stopTime = new Date();
          const startTime = await startTimeRes;
          context.octokit.repos.createCommitStatus({
            owner: context.payload.repository.owner.login,
            repo: "dtk",
            sha: context.payload.pull_request.head.sha,
            state: "success",
            context: "auto-update / deliver-pr",
            description: "Successful in " + getDurationDescription(stopTime.getTime() - startTime.getTime())
          })
          if (bot.workDir) {
            rm(bot.workDir, {recursive: true, force: true}, _ => {
              context.log.info("Work directory removed.");
            });
          }
        }
        updateDeliverStatus(context);
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
      let stop_at = new Date();
      context.log.info(`All checks completed for ${context.payload.check_run.pull_requests[0].url}.`);
      // Update commit status to done
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
            target_url: updatePR.commit_status.pull_url,
            description: "Successful in " + getDurationDescription(stop_at.getTime() - updatePR.started_at.getTime())
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
      }
    }
  });
};
