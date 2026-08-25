import { readFile, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

type RendererTarget = {
  readonly displayImports: readonly {
    readonly specifier: string;
    readonly symbols: readonly string[];
  }[];
  readonly file: string;
  readonly projection: string;
};

type ModuleRecord = {
  readonly descriptor: any;
  readonly file: string;
  readonly sourceFile: any;
  readonly templateCode: string | undefined;
};

const rendererDirectory = ["apps", "web", "components", "formal"] as const;
const webDirectory = ["apps", "web"] as const;
const rendererContracts = "@digital/presentation/renderer-contracts";

/**
 * 这些是具体的子渲染器隔膜，而非包级约定：每个渲染器都能消费提供给它的只读投影和
 * 视觉原语，但不能构造视图、调用动作或触及浏览器/全局效果边界。
 */
const targets: readonly RendererTarget[] = [
  {
    displayImports: [
      { specifier: "./AssetCover.vue", symbols: ["default"] },
      { specifier: "#/components/ui/badge", symbols: ["Badge"] },
      {
        specifier: "#/components/ui/card",
        symbols: ["Card", "CardContent", "CardHeader", "CardTitle"],
      },
    ],
    file: "DlsiteAssetCard.vue",
    projection: "DlsiteCardRendererProjection",
  },
  {
    displayImports: [
      { specifier: "./AssetCover.vue", symbols: ["default"] },
      { specifier: "@lucide/vue", symbols: ["ExternalLink"] },
      { specifier: "#/components/ui/badge", symbols: ["Badge"] },
      { specifier: "#/components/ui/button", symbols: ["Button"] },
      {
        specifier: "#/components/ui/card",
        symbols: ["Card", "CardContent", "CardHeader", "CardTitle"],
      },
    ],
    file: "DlsiteAssetDetail.vue",
    projection: "DlsiteDetailRendererProjection",
  },
];

const trustedDisplayImports = new Map<string, ReadonlySet<string>>([
  ["@lucide/vue", new Set(["ExternalLink"])],
  ["@vueuse/core", new Set(["reactiveOmit"])],
  ["class-variance-authority", new Set(["VariantProps", "cva"])],
  ["clsx", new Set(["ClassValue", "clsx"])],
  ["reka-ui", new Set(["Primitive", "PrimitiveProps"])],
  ["tailwind-merge", new Set(["twMerge"])],
  ["vue", new Set(["HTMLAttributes", "computed"])],
]);
const forbiddenGlobalSymbols = new Set([
  "Bun",
  "Deno",
  "EventSource",
  "Function",
  "SharedWorker",
  "WebSocket",
  "Worker",
  "XMLHttpRequest",
  "document",
  "eval",
  "fetch",
  "globalThis",
  "localStorage",
  "location",
  "navigator",
  "process",
  "self",
  "sessionStorage",
  "window",
]);
const nativeActionAttributes = new Set([
  "action",
  "enctype",
  "formaction",
  "method",
]);
const nativeEmbeddedTags = new Set(["embed", "iframe", "object"]);
const nativeEmbeddedAttributes = new Map<string, ReadonlySet<string>>([
  ["iframe", new Set(["srcdoc"])],
]);
const nativeUrlAttributes = new Set([
  "archive",
  "background",
  "classid",
  "codebase",
  "data",
  "download",
  "dynsrc",
  "href",
  "imagesrcset",
  "lowsrc",
  "manifest",
  "ping",
  "poster",
  "src",
  "srcset",
  "xlink:href",
]);
const componentPolymorphicAttributes = new Set([
  "action",
  "archive",
  "as",
  "as-child",
  "aschild",
  "background",
  "classid",
  "codebase",
  "data",
  "download",
  "dynsrc",
  "formaction",
  "href",
  "imagesrcset",
  "is",
  "lowsrc",
  "manifest",
  "ping",
  "poster",
  "src",
  "srcdoc",
  "srcset",
  "to",
  "xlink:href",
]);

// 检查器刻意使用 Web 应用已安装的解析器。将解析锚定在当前工作区，
// 才能让一次性夹具根在不复制工具链的情况下运行同一个正式命令。
const webRequire = createRequire(
  path.join(process.cwd(), "apps", "web", "package.json"),
);
const ts = webRequire("typescript");
const vue = webRequire("vue/compiler-sfc");

/**
 * 作为官方根命令 `pnpm boundaries` 的一部分运行。可选根只用于让边界反例夹具针对
 * 一次性 Vue SFC 运行这条精确命令。
 *
 * 该图刻意保持精简：只遍历两个渲染器根、其本地显示依赖和导出符号。
 * 它不是第二个通用静态分析器。
 */
export async function checkRendererBoundaries(options?: {
  readonly root?: string;
}): Promise<readonly string[]> {
  const root = path.resolve(
    options?.root ??
      process.env.DIGITAL_RENDERER_BOUNDARY_ROOT ??
      process.cwd(),
  );
  const graph = rendererGraph(root);
  const failures: string[] = [];

  for (const target of targets) {
    const file = path.join(root, ...rendererDirectory, target.file);
    try {
      failures.push(...(await graph.check(file, target)));
    } catch (error: unknown) {
      if (isMissingFile(error)) {
        failures.push(`renderer boundary: missing ${file}`);
        continue;
      }
      throw error;
    }
  }
  return failures;
}

function rendererGraph(root: string): {
  readonly check: (
    file: string,
    target: RendererTarget,
  ) => Promise<readonly string[]>;
} {
  const records = new Map<string, Promise<ModuleRecord>>();

  async function moduleRecord(file: string): Promise<ModuleRecord> {
    const absolute = path.resolve(file);
    let record = records.get(absolute);
    if (record === undefined) {
      record = readModule(absolute);
      records.set(absolute, record);
    }
    return await record;
  }

  async function readModule(file: string): Promise<ModuleRecord> {
    const source = await readFile(file, "utf8");
    if (path.extname(file) !== ".vue") {
      return {
        descriptor: undefined,
        file,
        sourceFile: parseTypeScript(file, source),
        templateCode: undefined,
      };
    }

    const parsed = vue.parse(source, { filename: file });
    if (parsed.errors.length > 0) {
      throw new Error(
        `${file}: renderer boundary could not parse Vue SFC: ${parsed.errors.join(", ")}`,
      );
    }
    const template = parsed.descriptor.template;
    let templateCode: string | undefined;
    if (template !== null) {
      const compiled = vue.compileTemplate({
        filename: file,
        id: "renderer-boundary",
        source: template.content,
      });
      if (compiled.errors.length > 0) {
        throw new Error(
          `${file}: renderer boundary could not compile template: ${compiled.errors.join(", ")}`,
        );
      }
      templateCode = compiled.code;
    }
    const script = parsed.descriptor.scriptSetup ?? parsed.descriptor.script;
    return {
      descriptor: parsed.descriptor,
      file,
      sourceFile: parseTypeScript(file, script?.content ?? ""),
      templateCode,
    };
  }

  function parseTypeScript(file: string, source: string): any {
    return ts.createSourceFile(
      `${file}.ts`,
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
  }

  async function check(
    file: string,
    target: RendererTarget,
  ): Promise<readonly string[]> {
    const record = await moduleRecord(file);
    const failures = [
      ...checkRootScript(record, target),
      ...(await checkRootImports(record, target)),
      ...scanEffects(record),
      ...scanRootTemplateContext(record),
      ...scanNativeTemplateActions(record),
      ...scanRootNativeUrlChannels(record, target),
      ...scanRootComponentUsage(record, target),
    ];
    const closure = new Set<string>();
    for (const declaration of importsOf(record.sourceFile)) {
      if (isTypeOnly(declaration)) continue;
      const specifier = moduleSpecifier(declaration);
      if (
        specifier === undefined ||
        specifier === rendererContracts ||
        specifier === "@lucide/vue"
      ) {
        continue;
      }
      const resolved = await resolveLocal(record.file, specifier);
      if (resolved !== undefined) {
        failures.push(...(await inspectDisplayClosure(resolved, closure)));
      }
    }
    return unique(failures);
  }

  function checkRootScript(
    record: ModuleRecord,
    target: RendererTarget,
  ): readonly string[] {
    if (!record.descriptor?.scriptSetup) {
      return [`${record.file}: renderer must use a script setup readonly prop`];
    }
    let propsCount = 0;
    const failures: string[] = [];
    for (const statement of statementsOf(record.sourceFile)) {
      if (ts.isImportDeclaration(statement)) continue;
      if (isExactRendererProps(statement, target.projection)) {
        propsCount += 1;
        continue;
      }
      failures.push(`${record.file}: forbidden renderer runtime declaration`);
    }
    if (propsCount !== 1) {
      failures.push(
        `${record.file}: renderer must receive only ${target.projection}`,
      );
    }
    return failures;
  }

  async function checkRootImports(
    record: ModuleRecord,
    target: RendererTarget,
  ): Promise<readonly string[]> {
    let contractCount = 0;
    const failures: string[] = [];
    for (const declaration of importsOf(record.sourceFile)) {
      const specifier = moduleSpecifier(declaration);
      if (specifier === undefined) {
        failures.push(`${record.file}: forbidden renderer import expression`);
        continue;
      }
      if (specifier === rendererContracts) {
        if (isExactContractImport(declaration, target.projection)) {
          contractCount += 1;
        } else {
          failures.push(
            `${record.file}: renderer must import ${target.projection} from renderer-contracts`,
          );
        }
        continue;
      }
      const allowed = target.displayImports.find(
        (candidate) => candidate.specifier === specifier,
      );
      if (allowed === undefined) {
        failures.push(`${record.file}: forbidden renderer import ${specifier}`);
        continue;
      }
      if (specifier === "./AssetCover.vue") {
        if (!isExactAssetCoverImport(declaration)) {
          failures.push(
            `${record.file}: forbidden renderer import ${specifier}`,
          );
        }
        continue;
      }
      if (!isNamedDisplayImport(declaration)) {
        failures.push(`${record.file}: forbidden renderer import ${specifier}`);
        continue;
      }
      const importedSymbols = namedImports(declaration);
      if (
        importedSymbols.some(
          (imported) => !allowed.symbols.includes(imported.symbol),
        )
      ) {
        failures.push(`${record.file}: forbidden renderer import ${specifier}`);
        continue;
      }
      if (specifier === "@lucide/vue") continue;
      const resolved = await resolveLocal(record.file, specifier);
      if (resolved === undefined) {
        failures.push(`${record.file}: forbidden renderer import ${specifier}`);
        continue;
      }
      for (const imported of importedSymbols) {
        if (!(await isDisplayExport(resolved, imported.symbol, new Set()))) {
          failures.push(
            `${record.file}: renderer import ${imported.symbol} is not a display component`,
          );
        }
      }
    }
    if (contractCount !== 1) {
      failures.push(
        `${record.file}: renderer must import ${target.projection} from renderer-contracts`,
      );
    }
    return failures;
  }

  async function isDisplayExport(
    file: string,
    symbol: string,
    seen: Set<string>,
  ): Promise<boolean> {
    const key = `${file}\u0000${symbol}`;
    if (seen.has(key)) return false;
    seen.add(key);
    if (path.extname(file) === ".vue") return symbol === "default";

    const record = await moduleRecord(file);
    for (const statement of statementsOf(record.sourceFile)) {
      if (!ts.isExportDeclaration(statement)) continue;
      const specifier = moduleSpecifier(statement);
      if (specifier === undefined) continue;
      const resolved = await resolveLocal(record.file, specifier);
      if (resolved === undefined) continue;
      if (statement.exportClause === undefined) {
        if (await isDisplayExport(resolved, symbol, seen)) return true;
        continue;
      }
      if (!ts.isNamedExports(statement.exportClause)) continue;
      const exported = statement.exportClause.elements.find(
        (element: any) => element.name.text === symbol,
      );
      if (exported === undefined) continue;
      const sourceSymbol = exported.propertyName?.text ?? exported.name.text;
      return await isDisplayExport(resolved, sourceSymbol, seen);
    }
    return false;
  }

  async function inspectDisplayClosure(
    file: string,
    seen: Set<string>,
  ): Promise<readonly string[]> {
    if (seen.has(file)) return [];
    seen.add(file);
    if (!isTrustedDisplayFile(file)) {
      return [`${file}: forbidden renderer dependency outside display closure`];
    }
    const record = await moduleRecord(file);
    const failures = [...scanEffects(record)];
    for (const declaration of staticDependenciesOf(record)) {
      const specifier = moduleSpecifier(declaration);
      if (specifier === undefined) continue;
      const resolved = await resolveLocal(record.file, specifier);
      if (resolved !== undefined) {
        failures.push(...(await inspectDisplayClosure(resolved, seen)));
      } else if (!isTrustedDisplayImport(declaration, specifier)) {
        failures.push(
          `${record.file}: forbidden renderer dependency ${specifier}`,
        );
      }
    }
    return failures;
  }

  async function resolveLocal(
    fromFile: string,
    specifier: string,
  ): Promise<string | undefined> {
    let base: string | undefined;
    if (specifier.startsWith("#/")) {
      base = path.join(root, ...webDirectory, specifier.slice(2));
    } else if (specifier.startsWith(".")) {
      base = path.resolve(path.dirname(fromFile), specifier);
    }
    if (base === undefined) return undefined;
    for (const candidate of moduleCandidates(base)) {
      try {
        if ((await stat(candidate)).isFile()) return candidate;
      } catch (error: unknown) {
        if (!isMissingFile(error)) throw error;
      }
    }
    return undefined;
  }

  function isTrustedDisplayFile(file: string): boolean {
    const relative = path.relative(path.join(root, ...webDirectory), file);
    return (
      relative === path.join("components", "formal", "AssetCover.vue") ||
      relative === path.join("lib", "utils.ts") ||
      relative.startsWith(`components${path.sep}ui${path.sep}`)
    );
  }

  function scanEffects(record: ModuleRecord): readonly string[] {
    const failures = scanEffectNodes(record.sourceFile, record.file);
    if (record.templateCode !== undefined) {
      failures.push(
        ...scanEffectNodes(
          parseTypeScript(`${record.file}:template`, record.templateCode),
          `${record.file}:template`,
        ),
      );
    }
    return failures;
  }

  function scanRootTemplateContext(record: ModuleRecord): readonly string[] {
    if (record.templateCode === undefined) return [];
    const failures: string[] = [];
    const sourceFile = parseTypeScript(
      `${record.file}:template-context`,
      record.templateCode,
    );
    const allowed = new Set(["asset", "$slots"]);
    const visit = (node: any): void => {
      if (
        ts.isPropertyAccessExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "_ctx" &&
        !allowed.has(node.name.text)
      ) {
        failures.push(
          `${record.file}: template reads forbidden renderer context ${node.name.text}`,
        );
      }
      if (
        ts.isElementAccessExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "_ctx"
      ) {
        failures.push(
          `${record.file}: template reads forbidden computed renderer context`,
        );
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    return failures;
  }

  function scanNativeTemplateActions(record: ModuleRecord): readonly string[] {
    const root = record.descriptor?.template?.ast;
    if (root === undefined) return [];
    const failures: string[] = [];
    const visit = (node: any): void => {
      if (
        node.type === 1 &&
        node.props.some((prop: any) => prop.type === 7 && prop.name === "html")
      ) {
        failures.push(
          `${record.file}: forbidden native template action v-html`,
        );
      }
      if (node.type === 1 && node.tag === "component") {
        failures.push(
          `${record.file}: forbidden native template action dynamic component`,
        );
      }
      if (node.type === 1 && node.tagType === 0 && node.tag === "form") {
        failures.push(`${record.file}: forbidden native template action form`);
      }
      if (
        node.type === 1 &&
        node.tagType === 0 &&
        nativeEmbeddedTags.has(node.tag)
      ) {
        failures.push(
          `${record.file}: forbidden native template action ${node.tag}`,
        );
      }
      if (node.type === 1 && node.tagType === 0) {
        for (const prop of node.props) {
          if (isNativeDynamicAttributeBinding(prop)) {
            failures.push(
              `${record.file}: forbidden native template action dynamic attribute`,
            );
          }
          if (isNativeInlineHandler(prop)) {
            failures.push(
              `${record.file}: forbidden native template action inline handler`,
            );
          }
          const attribute = nativeAttributeName(prop);
          if (
            attribute !== undefined &&
            (nativeActionAttributes.has(attribute) ||
              nativeEmbeddedAttributes.get(node.tag)?.has(attribute))
          ) {
            failures.push(
              `${record.file}: forbidden native template action ${attribute}`,
            );
          }
        }
      }
      for (const child of node.children ?? []) visit(child);
    };
    visit(root);
    return failures;
  }

  function scanRootNativeUrlChannels(
    record: ModuleRecord,
    target: RendererTarget,
  ): readonly string[] {
    const root = record.descriptor?.template?.ast;
    if (root === undefined) return [];
    const failures: string[] = [];
    const visit = (node: any): void => {
      if (node.type === 1 && node.tagType === 0) {
        if (
          node.tag === "meta" &&
          node.props.some((prop: any) => isMetaRefresh(prop))
        ) {
          failures.push(
            `${record.file}: forbidden root native URL channel meta refresh`,
          );
        }
        for (const prop of node.props) {
          const attribute = nativeAttributeName(prop)?.toLocaleLowerCase();
          if (
            attribute !== undefined &&
            nativeUrlAttributes.has(attribute) &&
            !isExactCardAssetNavigation(target, node, prop, attribute)
          ) {
            failures.push(
              `${record.file}: forbidden root native URL attribute ${attribute}`,
            );
          }
        }
      }
      for (const child of node.children ?? []) visit(child);
    };
    visit(root);
    return failures;
  }

  function scanRootComponentUsage(
    record: ModuleRecord,
    target: RendererTarget,
  ): readonly string[] {
    const root = record.descriptor?.template?.ast;
    if (root === undefined) return [];
    const failures: string[] = [];
    const visit = (node: any): void => {
      if (node.type === 1 && node.tagType === 1) {
        const hasSensitiveProp = node.props.some(isSensitiveComponentProp);
        if (
          node.tag === "AssetCover" &&
          !isExactAssetCoverUsage(target, node)
        ) {
          failures.push(
            `${record.file}: forbidden renderer component usage AssetCover`,
          );
        } else if (
          node.tag === "Button" &&
          hasSensitiveProp &&
          !isExactDetailOfficialPageButton(target, node)
        ) {
          failures.push(
            `${record.file}: forbidden renderer component usage Button`,
          );
        } else if (
          node.tag !== "AssetCover" &&
          node.tag !== "Button" &&
          hasSensitiveProp
        ) {
          failures.push(
            `${record.file}: forbidden renderer component usage ${node.tag}`,
          );
        }
      }
      for (const child of node.children ?? []) visit(child);
    };
    visit(root);
    return failures;
  }

  return { check };
}

function isExactRendererProps(statement: any, projection: string): boolean {
  if (
    !ts.isExpressionStatement(statement) ||
    !ts.isCallExpression(statement.expression)
  ) {
    return false;
  }
  const call = statement.expression;
  if (
    !ts.isIdentifier(call.expression) ||
    call.expression.text !== "defineProps" ||
    call.arguments.length !== 0 ||
    call.typeArguments?.length !== 1 ||
    !ts.isTypeLiteralNode(call.typeArguments[0])
  ) {
    return false;
  }
  const members = call.typeArguments[0].members;
  if (members.length !== 1 || !ts.isPropertySignature(members[0])) return false;
  const asset = members[0];
  return (
    ts.isIdentifier(asset.name) &&
    asset.name.text === "asset" &&
    asset.questionToken === undefined &&
    asset.modifiers?.some(
      (modifier: any) => modifier.kind === ts.SyntaxKind.ReadonlyKeyword,
    ) === true &&
    ts.isTypeReferenceNode(asset.type) &&
    ts.isIdentifier(asset.type.typeName) &&
    asset.type.typeName.text === projection
  );
}

function isExactContractImport(declaration: any, projection: string): boolean {
  const clause = declaration.importClause;
  return (
    clause?.isTypeOnly === true &&
    clause.name === undefined &&
    ts.isNamedImports(clause.namedBindings) &&
    clause.namedBindings.elements.length === 1 &&
    clause.namedBindings.elements[0].propertyName === undefined &&
    clause.namedBindings.elements[0].name.text === projection
  );
}

function isExactAssetCoverImport(declaration: any): boolean {
  const clause = declaration.importClause;
  return (
    clause?.isTypeOnly !== true &&
    clause?.name?.text === "AssetCover" &&
    clause.namedBindings === undefined
  );
}

function isNamedDisplayImport(declaration: any): boolean {
  const clause = declaration.importClause;
  return (
    clause?.isTypeOnly !== true &&
    clause?.name === undefined &&
    ts.isNamedImports(clause?.namedBindings) &&
    clause.namedBindings.elements.length > 0 &&
    clause.namedBindings.elements.every(
      (element: any) =>
        element.isTypeOnly !== true && startsWithUppercase(element.name.text),
    )
  );
}

function namedImports(
  declaration: any,
): readonly { readonly symbol: string }[] {
  const bindings = declaration.importClause?.namedBindings;
  if (!ts.isNamedImports(bindings)) return [];
  return bindings.elements.map((element: any) => ({
    symbol: element.propertyName?.text ?? element.name.text,
  }));
}

function importsOf(sourceFile: any): readonly any[] {
  return sourceFile.statements.filter((statement: any) =>
    ts.isImportDeclaration(statement),
  );
}

function staticDependenciesOf(record: ModuleRecord): readonly any[] {
  return record.sourceFile.statements.filter(
    (statement: any) =>
      ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement),
  );
}

function isTypeOnly(declaration: any): boolean {
  return declaration.importClause?.isTypeOnly === true;
}

function isTrustedDisplayImport(declaration: any, specifier: string): boolean {
  const allowed = trustedDisplayImports.get(specifier);
  const clause = declaration.importClause;
  return (
    allowed !== undefined &&
    ts.isImportDeclaration(declaration) &&
    clause?.name === undefined &&
    ts.isNamedImports(clause.namedBindings) &&
    clause.namedBindings.elements.length > 0 &&
    clause.namedBindings.elements.every((element: any) =>
      allowed.has(element.propertyName?.text ?? element.name.text),
    )
  );
}

function moduleSpecifier(declaration: any): string | undefined {
  return ts.isStringLiteral(declaration.moduleSpecifier)
    ? declaration.moduleSpecifier.text
    : undefined;
}

function nativeAttributeName(prop: any): string | undefined {
  if (prop.type === 6) return prop.name;
  if (prop.type === 7 && prop.name === "bind" && prop.arg?.isStatic) {
    return prop.arg.content;
  }
  return undefined;
}

function isNativeInlineHandler(prop: any): boolean {
  return (
    (prop.type === 6 && prop.name.toLocaleLowerCase().startsWith("on")) ||
    (prop.type === 7 && prop.name === "on")
  );
}

function isNativeDynamicAttributeBinding(prop: any): boolean {
  return prop.type === 7 && prop.name === "bind" && prop.arg?.isStatic !== true;
}

function isSensitiveComponentProp(prop: any): boolean {
  const attribute = nativeAttributeName(prop);
  return (
    isNativeDynamicAttributeBinding(prop) ||
    (attribute !== undefined &&
      componentPolymorphicAttributes.has(attribute.toLocaleLowerCase()))
  );
}

function isExactCardAssetNavigation(
  target: RendererTarget,
  node: any,
  prop: any,
  attribute: string,
): boolean {
  const expression = prop.exp?.ast;
  return (
    target.file === "DlsiteAssetCard.vue" &&
    node.tag === "a" &&
    node.ns === 0 &&
    attribute === "href" &&
    prop.type === 7 &&
    prop.name === "bind" &&
    prop.arg?.isStatic === true &&
    prop.arg.content === "href" &&
    expression?.type === "TemplateLiteral" &&
    expression.quasis?.length === 2 &&
    expression.quasis[0].value.cooked === "/assets/" &&
    expression.quasis[1].value.cooked === "" &&
    expression.expressions?.length === 1 &&
    isAssetIdMemberExpression(expression.expressions[0])
  );
}

function isAssetIdMemberExpression(expression: any): boolean {
  return (
    expression?.type === "MemberExpression" &&
    expression.computed === false &&
    expression.object?.type === "Identifier" &&
    expression.object.name === "asset" &&
    expression.property?.type === "Identifier" &&
    expression.property.name === "id"
  );
}

function isExactDetailOfficialPageButton(
  target: RendererTarget,
  node: any,
): boolean {
  return (
    target.file === "DlsiteAssetDetail.vue" &&
    node.props.length === 6 &&
    hasProjectionDirective(node, "if", undefined, "officialPage") &&
    hasStaticAttribute(node, "as", "a") &&
    hasProjectionDirective(node, "bind", "href", "officialPage") &&
    hasStaticAttribute(node, "target", "_blank") &&
    hasStaticAttribute(node, "rel", "noreferrer") &&
    hasStaticAttribute(node, "variant", "outline")
  );
}

function isExactAssetCoverUsage(target: RendererTarget, node: any): boolean {
  const placement =
    target.file === "DlsiteAssetCard.vue"
      ? "card"
      : target.file === "DlsiteAssetDetail.vue"
        ? "detail"
        : undefined;
  return (
    placement !== undefined &&
    node.props.length === 3 &&
    hasProjectionPathDirective(node, "bind", "src", ["dlsite", "cover"]) &&
    hasProjectionPathDirective(node, "bind", "title", ["dlsite", "title"]) &&
    hasStaticAttribute(node, "placement", placement)
  );
}

function hasProjectionDirective(
  node: any,
  directive: string,
  argument: string | undefined,
  property: string,
): boolean {
  return node.props.some(
    (prop: any) =>
      prop.type === 7 &&
      prop.name === directive &&
      (argument === undefined
        ? prop.arg === undefined
        : prop.arg?.isStatic === true && prop.arg.content === argument) &&
      isProjectionMemberExpression(prop.exp?.ast, property),
  );
}

function hasProjectionPathDirective(
  node: any,
  directive: string,
  argument: string,
  path: readonly string[],
): boolean {
  return node.props.some(
    (prop: any) =>
      prop.type === 7 &&
      prop.name === directive &&
      prop.arg?.isStatic === true &&
      prop.arg.content === argument &&
      isProjectionPathMemberExpression(prop.exp?.ast, path),
  );
}

function hasStaticAttribute(node: any, name: string, value: string): boolean {
  return node.props.some(
    (prop: any) =>
      prop.type === 6 && prop.name === name && prop.value?.content === value,
  );
}

function isProjectionMemberExpression(
  expression: any,
  property: string,
): boolean {
  return (
    expression?.type === "MemberExpression" &&
    expression.computed === false &&
    expression.object?.type === "Identifier" &&
    expression.object.name === "asset" &&
    expression.property?.type === "Identifier" &&
    expression.property.name === property
  );
}

function isProjectionPathMemberExpression(
  expression: any,
  path: readonly string[],
): boolean {
  let current = expression;
  for (let index = path.length - 1; index >= 0; index -= 1) {
    if (
      current?.type !== "MemberExpression" ||
      current.computed !== false ||
      current.property?.type !== "Identifier" ||
      current.property.name !== path[index]
    ) {
      return false;
    }
    current = current.object;
  }
  return current?.type === "Identifier" && current.name === "asset";
}

function isMetaRefresh(prop: any): boolean {
  if (nativeAttributeName(prop) !== "http-equiv") return false;
  if (prop.type === 7) return true;
  return prop.value?.content?.toLocaleLowerCase() === "refresh";
}

function scanEffectNodes(sourceFile: any, file: string): string[] {
  const failures: string[] = [];
  const visit = (node: any): void => {
    if (ts.isIdentifier(node)) {
      if (forbiddenGlobalSymbols.has(node.text)) {
        failures.push(
          `${file}: forbidden renderer effect global symbol ${node.text}`,
        );
      }
      if (node.text === "require") {
        failures.push(`${file}: forbidden renderer effect require`);
      }
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      failures.push(`${file}: forbidden renderer effect dynamic import`);
    }
    if (ts.isImportEqualsDeclaration(node)) {
      failures.push(`${file}: forbidden renderer effect CommonJS import`);
    }
    if (ts.isExportAssignment(node) && node.isExportEquals) {
      failures.push(`${file}: forbidden renderer effect CommonJS export`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return failures;
}

function statementsOf(sourceFile: any): readonly any[] {
  return sourceFile.statements;
}

function startsWithUppercase(value: string): boolean {
  const firstCharacter = value[0];
  return (
    firstCharacter !== undefined &&
    firstCharacter !== firstCharacter.toLocaleLowerCase()
  );
}

function moduleCandidates(base: string): readonly string[] {
  if (path.extname(base) !== "") return [base];
  return [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.jsx`,
    `${base}.vue`,
    path.join(base, "index.ts"),
    path.join(base, "index.tsx"),
    path.join(base, "index.js"),
    path.join(base, "index.jsx"),
    path.join(base, "index.vue"),
  ];
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "ENOENT"
  );
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === new URL(import.meta.url).pathname
) {
  const failures = await checkRendererBoundaries();
  if (failures.length > 0) {
    process.stderr.write(`${failures.join("\n")}\n`);
    process.exitCode = 1;
  }
}
