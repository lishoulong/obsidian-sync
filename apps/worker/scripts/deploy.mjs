import { readFile, unlink, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, printParseErrorCode } from "jsonc-parser";

const PLACEHOLDER_ID = "00000000-0000-0000-0000-000000000000";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = resolve(packageRoot, "wrangler.jsonc");
const temporaryPath = resolve(
  packageRoot,
  `.wrangler.deploy.${process.pid}.jsonc`,
);

function fail(message) {
  console.error(`VaultBridge deployment configuration error: ${message}`);
  process.exitCode = 1;
}

function runWrangler(args) {
  const executable = process.platform === "win32" ? "wrangler.cmd" : "wrangler";
  const result = spawnSync(executable, args, {
    stdio: "inherit",
    env: process.env,
    cwd: packageRoot,
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`wrangler exited with status ${String(result.status)}`);
}

let temporaryWritten = false;
try {
  const parseErrors = [];
  const config = parse(await readFile(sourcePath, "utf8"), parseErrors, {
    allowTrailingComma: true,
  });
  if (parseErrors.length > 0) {
    const details = parseErrors
      .map((error) => `${printParseErrorCode(error.error)} at ${error.offset}`)
      .join(", ");
    throw new Error(`wrangler.jsonc is invalid: ${details}`);
  }
  const databases = config.d1_databases;
  const database = Array.isArray(databases)
    ? databases.find((candidate) => candidate?.binding === "DB")
    : undefined;
  if (!database)
    throw new Error('wrangler.jsonc must declare a D1 binding named "DB"');

  const environmentId = String(process.env.D1_DATABASE_ID || "").trim();
  const databaseId = environmentId || String(database.database_id || "").trim();
  if (!UUID_PATTERN.test(databaseId) || databaseId === PLACEHOLDER_ID) {
    fail(
      "D1_DATABASE_ID is missing or invalid. For an existing Worker, create/bind a D1 database and set D1_DATABASE_ID in the deployment environment. The all-zero value is only a Deploy Button provisioning placeholder.",
    );
  } else {
    database.database_id = databaseId;
    await writeFile(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, {
      mode: 0o600,
    });
    temporaryWritten = true;
    console.log(
      `Using D1 database ${databaseId} from ${environmentId ? "D1_DATABASE_ID" : "the provisioned Wrangler configuration"}.`,
    );

    if (!process.argv.includes("--check-only")) {
      const configArgs = ["--config", temporaryPath];
      runWrangler([
        "d1",
        "migrations",
        "apply",
        "DB",
        "--remote",
        ...configArgs,
      ]);
      if (!process.argv.includes("--migrate-only"))
        runWrangler(["deploy", ...configArgs]);
    }
  }
} catch (error) {
  if (!process.exitCode)
    fail(error instanceof Error ? error.message : String(error));
} finally {
  if (temporaryWritten) await unlink(temporaryPath).catch(() => undefined);
}
