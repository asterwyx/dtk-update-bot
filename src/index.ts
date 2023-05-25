import { Probot, ProbotOctokit } from "probot";
import { DeprecatedLogger } from "probot/lib/types";

enum BotState {
  IDLE,
  UPDATING
}
class RepoInfo {
  owner: string;
  repo: string;
  constructor(owner: string, repo: string) {
    this.owner = owner;
    this.repo = repo;
  }

}
class PullRequestInfo extends RepoInfo {
  pull_number: number;
  constructor(owner: string, repo: string, pull_number: number) {
    super(owner, repo);
    this.pull_number = pull_number;
  }

}

class UpdateBot {
  state: BotState;
  currentUpdatePRID: number;
  updatePR: PullRequestInfo | null;
  submoduleUpdatePRs: PullRequestInfo[];

  constructor() {
    this.state = BotState.IDLE;
    this.currentUpdatePRID = -1;
    this.updatePR = null;
    this.submoduleUpdatePRs = [];
  }
  async checksCompleted(octokit: InstanceType<typeof ProbotOctokit>, PR : PullRequestInfo, logger: DeprecatedLogger) : Promise<boolean> {
    logger.info(PR);
    if (this.state == BotState.IDLE) {
      return false;
    } else if (this.state == BotState.UPDATING) {
      let {data: PRInfo} = await octokit.pulls.get(PR as any);
      let repoWithRef = (PR as RepoInfo) as any & {ref: string};
      repoWithRef.ref = PRInfo.head.sha;
      let combinedStatus = await octokit.repos.getCombinedStatusForRef(repoWithRef);
      if (combinedStatus.data.state == "success") {
        return true;
      }
    }
    return false;
  }
}

// Global update bot
let bot: UpdateBot = new UpdateBot();

export = (app: Probot) => {
  app.on("issues.opened", async (context) => {
    const issueComment = context.issue({
      body: "Thanks for opening this issue!",
    });
    await context.octokit.issues.createComment(issueComment);
  });

  app.on(["pull_request.opened", "pull_request.reopened", "pull_request.synchronize"], async (context) => {
    context.pullRequest()
    context.log.info(`PR for repo ${context.payload.repository.name} was opened. Number: ${context.payload.number}. URL: ${context.payload.pull_request.url}.`);
  });

  app.on("check_run.completed", async (context) => {
    context.log.info(`Check run ${context.payload.check_run.name} completed`);
    context.log.info(`PR: ${context.payload.check_run.pull_requests[0].url}`);
    let completed = await bot.checksCompleted(context.octokit, context.repo({pull_number: context.payload.check_run.pull_requests[0].number}), context.log);
    context.log.info(`All checks completed: ${completed}`);
  });
};
