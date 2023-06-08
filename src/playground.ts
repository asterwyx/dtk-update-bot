// import { decode } from "ini";
// import { readFileSync } from "fs";
// import { Octokit } from "@octokit/rest";
// import { createAppAuth } from "@octokit/auth-app";
// const envContent = readFileSync(".env", "utf-8");
// const env = decode(envContent);
// const octokit = new Octokit({
//   authStrategy: createAppAuth,
//   auth: {
//     appId: env.APP_ID,
//     privateKey: env.PRIVATE_KEY,
//     clientId: env.GITHUB_CLIENT_ID,
//     clientSecret: env.GITHUB_CLIENT_SECRET,
//   }
// });
// new Promise( async resolve => {
//   let {data: installation} = await octokit.apps.getOrgInstallation({org: "peeweep-test"})
//   console.log(installation.id);
//   let installationOctokit = new Octokit({
//     authStrategy: createAppAuth,
//     auth: {
//       appId: env.APP_ID,
//       privateKey: env.PRIVATE_KEY,
//       installationId: installation.id
//     }
//   })
//   let {data: content} = await installationOctokit.rest.repos.getContent({
//     owner: "peeweep-test",
//     repo: "dtk",
//     path: ".gitmodules",
//   });
//   console.log(Array.isArray(content));
//   // console.log(content);
//   resolve(content);


// });
let date = new Date();
console.log(date.toUTCString());
console.log(date.toString());
console.log(date.toDateString());
