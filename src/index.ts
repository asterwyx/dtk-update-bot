import { Context, Probot, ProbotOctokit } from "probot";
import { PullRequest } from "@octokit/webhooks-types";
enum BotState {
  IDLE,
  UPDATING
};

type SubmoduleInfo = {
  owner: string,
  repo: string,
  context: string,
  pull_number: number,
  sha: string,
  url: string,
  state: "success" | "pending" | "failure" | "error"
};

class UpdateBot {
  state: BotState;
  currentUpdatePRID: number;
  updatePR: PullRequest | null;
  submoduleInfo: Map<string, SubmoduleInfo>;

  constructor() {
    this.state = BotState.IDLE;
    this.currentUpdatePRID = -1;
    this.updatePR = null;
    this.submoduleInfo = new Map;
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
      context.log.error(e);
      return false;
    }
  }

  async logUpdate(app: Probot) {
    bot.state = BotState.IDLE;
    return this.updateSubmodules(app);
  }

  async updateSubmodules(app: Probot) {
    app.log.info("Start updating submodules for dtk...");
    return true;
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
        ref: submoduleInfo.sha
      });
      if (checks.total_count === 0 && bot.updatePR !== null) {
        let result = await octokit.repos.createCommitStatus({
          owner: submoduleInfo.owner,
          repo: "dtk",
          sha: bot.updatePR.head.sha,
          state: "success",
          context: submoduleInfo.context,
          target_url: submoduleInfo.url
        });
        if (result.status === 201) {
          submoduleInfo.state = "success";
          resolve(result);
        } else {
          reject(result);
        }
      }
      reject(null);
    }, 10000));
}

export = (app: Probot) => {
  app.on(["pull_request.opened", "pull_request.reopened", "pull_request.synchronize"], async (context) => {
    if (context.payload.repository.name === "dtk") {
      bot.state = BotState.UPDATING;
      bot.currentUpdatePRID = context.payload.number;
      bot.updatePR = context.payload.pull_request;
      context.log.info(`PR for repo ${context.payload.repository.name} ${context.payload.action}. Number: ${context.payload.number}. URL: ${context.payload.pull_request.html_url}.`);
    }
  });

  app.on("pull_request_review.submitted", async (context) => {
    context.log.info(`PR review for repo ${context.payload.repository.name} was submitted by ${context.payload.review.user.login}. Number: ${context.payload.pull_request.number}. URL: ${context.payload.pull_request.url}.`);
    let approved = await bot.PRApproved(context, context.payload.pull_request.number);
    context.log.info(`PR approved: ${approved}`);
    if (context.payload.pull_request.number === bot.currentUpdatePRID && approved) {
      bot.logUpdate(app);
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
        let ready = await bot.checksReady(context, updatePR.pull_number);
        if (ready) {
          state = "success";
        } else {
          state = "failure";
        }
        context.log.info(`Updating commit status ${updatePR.context} to ${state}.`);
        if (bot.updatePR !== null) {
          let result = await context.octokit.repos.createCommitStatus({
            owner: context.payload.repository.owner.login,
            repo: "dtk",
            sha: bot.updatePR.head.sha,
            state: state,
            context: updatePR.context,
            target_url: updatePR.url
          });
          if (result.status === 201) {
            updatePR.state = "success";
          }
        }
      }
      // Check if this PR is the update PR for dtk
      if (context.payload.check_run.pull_requests[0].number === bot.currentUpdatePRID && state === "success") {
        // All checks and commit statuses are ready for update PR, we should check if this PR is approved.
        let approved = await bot.PRApproved(context, context.payload.check_run.pull_requests[0].number);
        context.log.info(`Update PR approved: ${approved}`);
        if (approved) {
          bot.logUpdate(app);
        }
      }
    }
  });

  app.on("status", async (context) => {
    context.log.info(`Status ${context.payload.context} -- ${context.payload.state} for ${context.payload.sha} in ${context.payload.repository.name}`);
    const contextPattern = /auto-update\s\/\scheck-update\s\((?<repo>\w+)\)/g;
    let match = contextPattern.exec(context.payload.context);
    if (match !== null && match.groups !== undefined && bot.state === BotState.UPDATING) {
      let repo = match.groups.repo;
      let url = context.payload.target_url;
      if (url !== null) {
        const urlPattern = /\w+\/pull\/(?<number>\d+)/;
        let urlMatch = urlPattern.exec(url);
        if (urlMatch !== null && urlMatch.groups !== undefined) {
          let pullNumber = parseInt(urlMatch.groups.number);
          context.log.info(`Extracted update PR ${url} from status ${context.payload.name} for repo ${repo}.`);
          let {data: PRInfo} = await context.octokit.pulls.get({
            owner: context.payload.repository.owner.login,
            repo: match.groups.repo,
            pull_number: pullNumber
          });
          let info = bot.submoduleInfo.get(repo);
          if (info === undefined) {
            info = {
              owner: context.payload.repository.owner.login,
              repo: repo,
              pull_number: pullNumber,
              context: context.payload.context,
              sha: PRInfo.head.sha,
              url: url,
              state: "pending"
            };
            bot.submoduleInfo.set(repo, info);
          }
          // List workflows for this repo, if there aren't any, then we assume checks are passed
          // Note that this is insufficient but required. GitHub will return an empty array if there
          // are no files under .github/workflows or GitHub Actions is not enabled for the repo.
          // The more accurate way is to detect if there are any checks for this PR. However, there will
          // be some delay between checks starting and the status event being fired. We may get a wrong result.
          // Just use a timer to handle this
          if (info.state !== "success") {
            handleEmptyChecks(context.octokit, info).catch((err) => {
              context.log.error(err);
            });
          }
        }
      }
    }
  });
};
