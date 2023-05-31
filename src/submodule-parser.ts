import { readFileSync } from "fs";
import ini from "ini";
export type Submodule = {
  name: string,
  path: string,
  url: string,
  branch: string
};

export function parseDotGitmodulesContent(content: string) : Array<Submodule> {
  let modules = ini.parse(content);
  let submodules : Array<Submodule> = [];
  for (let [key, value] of Object.entries(modules)) {
    const rg = /submodule\s\"(?<name>\w+)\"/;
    let match = rg.exec(key);
    if (match === null || match.groups === undefined) {
      continue;
    }
    submodules.push({
      name: match.groups.name,
      path: value.path,
      url: value.url,
      branch: value.branch
    });
  }
  return submodules;
}

export function parseDotGitmodulesFile(file: string) {
  let content = readFileSync(file, "utf8");
  console.log(content);
  return parseDotGitmodulesContent(content);
}

export function buildDotGitmodulesContent(submodules: Array<Submodule>) {
  let content = "";
  for (let submodule of submodules) {
    content += "[submodule \"" + submodule.name + "\"]\n";
    content += "\tpath = " + submodule.path + "\n";
    content += "\turl = " + submodule.url + "\n";
    content += "\tbranch = " + submodule.branch + "\n";
  }
  return content;
}
