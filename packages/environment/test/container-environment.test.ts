import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { expect, test } from "vitest";

import { manageContainerEnvironment } from "../src/index.ts";

/** 仅在 Docker 命令外部边界模拟应答丢失；对象状态和收尾结果由公开操作观察。 */
test.each(["legacy", "current"])(
  "创建应答丢失及 %s 对象不存在应答：保留数据和首因，只收尾自有资源",
  async (missingObjectDiagnostic) => {
    const root = await mkdtemp(
      path.join(tmpdir(), "digital-container-response-loss-"),
    );
    const state = path.join(root, "daemon.json");
    // 夹具内容是纯 JavaScript；明确 ESM 扩展名，避免每条 Docker 命令重复处理 TypeScript 入口。
    const cli = path.join(root, "docker.mjs");
    await writeFile(
      state,
      JSON.stringify({
        missingObjectDiagnostic,
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
 const o=find(args[0]);if(!o){console.error(state.missingObjectDiagnostic==='current'&&args[0]==='network'?'Error response from daemon: network '+args.at(-1)+' not found':state.missingObjectDiagnostic==='current'&&args[0]==='volume'?'Error response from daemon: get '+args.at(-1)+': no such volume':'Error: No such '+args[0]+': '+args.at(-1));process.exit(1)}output=JSON.stringify([o]);
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
        inspected.observation?.objects.find(
          (object) => object.id === "owned-id",
        ),
      ).toMatchObject({ running: false, pid: 0, exitCode: 143 });
      expect(
        inspected.observation?.objects.find(
          (object) => object.kind === "volume",
        ),
      ).toMatchObject({ state: "present" });
      const actual = JSON.parse(await readFile(state, "utf8")) as {
        containers: { Id: string; State: { Running: boolean } }[];
      };
      expect(
        actual.containers.find((object) => object.Id === "external-id")?.State
          .Running,
      ).toBe(true);
      await writeFile(state, JSON.stringify({ ...actual, networks: [] }));
      const networkRemoved = await manageContainerEnvironment({
        ...reference,
        action: "inspect",
      });
      expect(networkRemoved.status).toBe("ok");
      expect(
        networkRemoved.observation?.objects.find(
          (object) => object.kind === "network",
        ),
      ).toMatchObject({ state: "absent" });
      expect(
        networkRemoved.observation?.objects.find(
          (object) => object.kind === "volume",
        ),
      ).toMatchObject({ state: "present" });
      const withoutNetwork = JSON.parse(await readFile(state, "utf8")) as {
        volumes: unknown[];
      };
      await writeFile(
        state,
        JSON.stringify({ ...withoutNetwork, volumes: [] }),
      );
      const volumeRemoved = await manageContainerEnvironment({
        ...reference,
        action: "inspect",
      });
      expect(volumeRemoved.status).toBe("ok");
      expect(
        volumeRemoved.observation?.objects.find(
          (object) => object.kind === "volume",
        ),
      ).toMatchObject({ state: "absent" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("容器创建前失败时先通过只读载体保存本次自有卷，再回收其资源", async () => {
  const root = await mkdtemp(
    path.join(tmpdir(), "digital-container-save-volume-"),
  );
  const statePath = path.join(root, "daemon.json");
  const volumeData = path.join(root, "volume-data");
  const saved = path.join(root, "saved");
  const cli = path.join(root, "docker.mjs");
  const missingMount = path.join(root, "not-mounted");
  await mkdir(volumeData, { recursive: true });
  await writeFile(
    path.join(volumeData, "catalogue.sqlite"),
    "actual volume bytes",
  );
  await writeFile(
    statePath,
    JSON.stringify({
      dataDirectory: volumeData,
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
const filters=args.flatMap((a,i)=>a==='--filter'?[args[i+1].slice('label='.length)]:[]);
const matches=o=>filters.every(pair=>{const [k,v]=pair.split(/=(.*)/s);return (o.Labels??o.Config?.Labels)?.[k]===v});
const find=(kind,id)=>list(kind).find(o=>[o.Id,o.Name,o.Name?.replace(/^\\//u,'')].includes(id));
let output='';
if(args[0]==='info')output='daemon-one';
else if(args[0]==='image'&&args[1]==='inspect')output='sha256:image-one';
else if((args[0]==='volume'||args[0]==='network')&&args[1]==='create'){
 const kind=args[0],name=args.at(-1),o={Id:kind+'-id',Name:name,Labels:labels(),CreatedAt:'2026-10-10T00:00:00Z'};list(kind).push(o);output=kind==='volume'?name:o.Id;
}else if(args[1]==='ls')output=list(args[0]).filter(matches).map(o=>args[0]==='volume'?o.Name:o.Id).join('\\n');
else if(['container','volume','network'].includes(args[0])&&args[1]==='inspect'){
 const o=find(args[0],args.at(-1));if(!o){console.error('Error: No such '+args[0]+': '+args.at(-1));process.exit(1)}output=JSON.stringify([o]);
}else if(args[0]==='container'&&args[1]==='create'){
 const missing=args.find(a=>a.startsWith('type=bind,source='));if(missing){console.error('Error response from daemon: invalid mount config for type "bind": bind source path does not exist: '+missing.split(',')[1].split('=')[1]);process.exit(125)}
 const mounts=args.flatMap((a,i)=>a==='--mount'?[args[i+1]]:[]);if(args[args.indexOf('--network')+1]!=='none'||!args.includes('--read-only')||mounts.length!==1||!mounts[0].startsWith('type=volume,source=')||!mounts[0].endsWith(',target=/data,readonly')||args[args.indexOf('--entrypoint')+1]!=='/bin/true')throw Error('snapshot helper must be networkless, read-only, and attached only to the owned volume');
 const name=args[args.indexOf('--name')+1],o={Id:'snapshot-id',Name:'/'+name,Config:{Labels:labels()},Image:'sha256:image-one',State:{Running:false,Pid:0,ExitCode:0,OOMKilled:false},NetworkSettings:{Ports:{}},DataVolume:args.find(a=>a.startsWith('type=volume,source='))};state.containers.push(o);fs.writeFileSync(file,JSON.stringify(state));output=o.Id;
}else if(args[0]==='container'&&args[1]==='cp'){
 const [source,destination]=args.slice(2);const id=source.split(':')[0],carrier=find('container',id);if(!carrier?.DataVolume)throw Error('snapshot container has no data volume');fs.cpSync(state.dataDirectory,destination,{recursive:true});output='';
}else if(args[0]==='container'&&args[1]==='rm'){
 const id=args.at(-1);state.containers=state.containers.filter(o=>o.Id!==id);output=id;
}else if(args[0]==='network'&&args[1]==='rm'){
 const id=args.at(-1);state.networks=state.networks.filter(o=>o.Id!==id);output=id;
}else if(args[0]==='volume'&&args[1]==='rm'){
 const id=args.at(-1);state.volumes=state.volumes.filter(o=>o.Name!==id);output=id;
}else if(args[0]==='container'&&args[1]==='logs')output='owned diagnostic';
else throw Error('unsupported external command '+JSON.stringify(args));
fs.writeFileSync(file,JSON.stringify(state));console.log(output);
`,
  );

  try {
    const reference = { workspacePath: root, environment: "empty-carrier" };
    const endpoint = {
      command: process.execPath,
      arguments: [cli, statePath],
      host: "unix:///test-daemon",
    };
    const prepared = await manageContainerEnvironment({
      ...reference,
      action: "prepare",
      endpoint,
      image: "provided-image",
    });
    expect(prepared.status).toBe("ok");

    const failed = await manageContainerEnvironment({
      ...reference,
      action: "start",
      waitFor: "running",
      mounts: [{ source: missingMount, target: "/observed", readonly: true }],
    });
    expect(failed.status).toBe("failed");
    expect(failed.failure?.message).toContain("source path does not exist");
    expect(
      failed.observation?.objects.filter(
        (object) => object.kind === "container",
      ),
    ).toMatchObject([{ state: "absent" }]);

    const savedResult = await manageContainerEnvironment({
      ...reference,
      action: "save",
      directory: saved,
      includeData: true,
    });
    expect(savedResult.status).toBe("ok");
    expect(savedResult.evidence).toMatchObject({ dataSaved: true });
    await expect(
      readFile(path.join(saved, "product-data", "catalogue.sqlite"), "utf8"),
    ).resolves.toBe("actual volume bytes");

    const deleted = await manageContainerEnvironment({
      ...reference,
      action: "delete",
      deleteData: true,
    });
    expect(deleted.status).toBe("ok");
    expect(deleted.remaining).toEqual([]);
    const actual = JSON.parse(await readFile(statePath, "utf8")) as {
      containers: { Id: string }[];
      networks: unknown[];
      volumes: unknown[];
    };
    expect(actual.containers.map(({ Id }) => Id)).toEqual(["external-id"]);
    expect(actual.networks).toEqual([]);
    expect(actual.volumes).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
