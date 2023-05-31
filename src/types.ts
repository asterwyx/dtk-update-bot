export enum BotState {
  IDLE,
  UPDATING
};

export type CommitStatus = {
  repo: string,
  context: string,
  description: string | null,
  state: "success" | "pending" | "failure" | "error",
  pull_sha: string,
  pull_number: number,
  pull_url: string
};

export const defaultCommitStatus: CommitStatus = {
  repo: "",
  context: "",
  description: "",
  state: "pending",
  pull_number: 0,
  pull_sha: "",
  pull_url: ""
}

export type SubmoduleInfo = {
  owner: string,
  repo: string,
  repo_url: string,
  branch: string,
  merged_sha: string,
  complete: boolean,
  commit_status: CommitStatus
};
