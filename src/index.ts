import { Context, Probot } from "probot";
enum BotState {
  IDLE,
  UPDATING
}
class UpdateBot {
  state: BotState;
  currentUpdatePRID: number;
  updatePR: number | null;
  submoduleUpdatePRs: number[];

  constructor() {
    this.state = BotState.IDLE;
    this.currentUpdatePRID = -1;
    this.updatePR = null;
    this.submoduleUpdatePRs = [];
  }
  async checksCompleted(context: Context, PRNumber: number) : Promise<boolean> {
    let PR = context.repo({pull_number: PRNumber});
    context.log.info(PR);
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

  async PRApproved(context: Context, PRNumber: number) : Promise<boolean> {
    let PR = context.repo({pull_number: PRNumber});
    context.log.info(PR);
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
      context.log.info(e);
      return false;
    }
  }
}

// Global update bot
let bot: UpdateBot = new UpdateBot();

export = (app: Probot) => {
  app.on(["pull_request.opened", "pull_request.reopened", "pull_request.synchronize"], async (context) => {
    bot.state = BotState.UPDATING;
    context.log.info(`PR for repo ${context.payload.repository.name} ${context.payload.action}. Number: ${context.payload.number}. URL: ${context.payload.pull_request.html_url}.`);
  });

  app.on("pull_request_review.submitted", async (context) => {
    context.log.info(`PR review for repo ${context.payload.repository.name} was submitted by ${context.payload.review.user.login}. Number: ${context.payload.pull_request.number}. URL: ${context.payload.pull_request.url}.`);
    let approved = await bot.PRApproved(context, context.payload.pull_request.number);
    context.log.info(`PR approved: ${approved}`);
  })

  app.on("check_run.completed", async (context) => {
    context.log.info(`Check run ${context.payload.check_run.name} completed`);
    context.log.info(`PR: ${context.payload.check_run.pull_requests[0].url}`);
    let completed = await bot.checksCompleted(context, context.payload.check_run.pull_requests[0].number);
    if (completed) {
      let approved = await bot.PRApproved(context, context.payload.check_run.pull_requests[0].number);
      context.log.info(`All checks completed for ${context.payload.check_run.pull_requests[0].url} PR approved: ${approved}`);
    }
  });
};
