import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { expect, test } from "vitest";

import { manageContainerEnvironment } from "../src/index.ts";

/** 仅在 Docker 命令外部边界模拟应答丢失；对象状态和收尾结果由公开操作观察。 */
test("创建应答丢失后停止已创建的自有容器，保留产品数据和原首因，不停止外部对象", async () => {
  const root = await mkdtemp(
    path.join(tmpdir(), "digital-container-response-loss-"),
  );
  const state = path.join(root, "daemon.json");
  const cli = path.join(root, "docker.ts");
  await writeFile(
    state,
    JSON.stringify({
      containers: [
        {
          Id: "external-id",
          Name: "/external",
          Config: { Labels: {} },
          State: { Running: true, Pid: 99, ExitCode: 0, OOMKilled: false },
          NetworkSettings: { Ports: {} },
        },
      ],
      images: [],
      volumes: [],
      networks: [],
    }),
  );
  await writeFile(
    cli,
    `import fs from 'node:fs';
const file=process.argv[2];const args=process.argv.slice(3).filter((_,i,a)=>a[i-1]!=='--host'&&a[i]!=='--host');
const state=JSON.parse(fs.readFileSync(file,'utf8'));
const labels=()=>Object.fromEntries(args.flatMap((a,i)=>a==='--label'?[args[i+1].split(/=(.*)/s).slice(0,2)]:[]));
const list=kind=>kind==='container'?state.containers:kind==='volume'?state.volumes:kind==='image'?state.images:state.networks;
const find=kind=>list(kind).find(o=>[o.Id,o.Name,o.Name?.slice(1)].includes(args.at(-1)));
const matches=o=>args.flatMap((a,i)=>a==='--filter'?[args[i+1].slice('label='.length)]:[]).every(pair=>{const [k,v]=pair.split(/=(.*)/s);return (o.Labels??o.Config?.Labels)?.[k]===v});
let output='';
if(args[0]==='info')output='daemon-one';
else if(args[0]==='image'&&args[1]==='inspect')output='sha256:image-one';
else if(args[1]==='create'&&args[0]!=='container'){
 const kind=args[0],name=args.at(-1);const o={Id:kind+'-id',Name:name,Labels:labels(),CreatedAt:'2026-10-10T00:00:00Z'};list(kind).push(o);output=kind==='volume'?name:o.Id;
}else if(args[0]==='container'&&args[1]==='create'){
 const name=args[args.indexOf('--name')+1],o={Id:'owned-id',Name:'/'+name,Config:{Labels:labels()},Image:'sha256:image-one',State:{Running:true,Pid:42,ExitCode:0,OOMKilled:false},NetworkSettings:{Ports:{}}};state.containers.push(o);fs.writeFileSync(file,JSON.stringify(state));console.error('creation response lost');process.exit(77);
}else if(args[1]==='ls')output=list(args[0]).filter(matches).map(o=>args[0]==='volume'?o.Name:o.Id).join('\\n');
else if(args[1]==='inspect'){
 const o=find(args[0]);if(!o){console.error('Error: No such '+args[0]+': '+args.at(-1));process.exit(1)}output=JSON.stringify([o]);
}else if(args[0]==='container'&&args[1]==='stop'){
 const o=find('container');if(!o)throw Error('missing');o.State={Running:false,Pid:0,ExitCode:143,OOMKilled:false};output=o.Id;
}else if(args[0]==='container'&&args[1]==='logs')output='full diagnostic';
else throw Error('unsupported external command '+JSON.stringify(args));
fs.writeFileSync(file,JSON.stringify(state));console.log(output);
`,
  );
  try {
    const reference = { workspacePath: root, environment: "response-loss" };
    const prepared = await manageContainerEnvironment({
      ...reference,
      action: "prepare",
      endpoint: {
        command: process.execPath,
        arguments: [cli, state],
        host: "unix:///test-daemon",
      },
      image: "provided-image",
    });
    expect(prepared.status).toBe("ok");
    const started = await manageContainerEnvironment({
      ...reference,
      action: "start",
      waitFor: "running",
    });
    expect(started.status).toBe("failed");
    expect(started.failure?.message).toContain("creation response lost");
    const inspected = await manageContainerEnvironment({
      ...reference,
      action: "inspect",
    });
    expect(
      inspected.observation?.objects.find((object) => object.id === "owned-id"),
    ).toMatchObject({ running: false, pid: 0, exitCode: 143 });
    expect(
      inspected.observation?.objects.find((object) => object.kind === "volume"),
    ).toMatchObject({ state: "present" });
    const actual = JSON.parse(await readFile(state, "utf8")) as {
      containers: { Id: string; State: { Running: boolean } }[];
    };
    expect(
      actual.containers.find((object) => object.Id === "external-id")?.State
        .Running,
    ).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
