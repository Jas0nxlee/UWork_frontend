import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("微盘同步覆盖发布事件、手动补传、单写入者和安全凭据传递", async () => {
  const workflow = await read(".github/workflows/wecom-release-sync.yml");
  assert.match(workflow, /release:\s+types: \[published\]/);
  assert.match(workflow, /workflow_dispatch:\s+inputs:\s+tag:/);
  assert.match(workflow, /concurrency:\s+group: wecom-release-sync\s+cancel-in-progress: false/);
  assert.match(workflow, /contents: read/);
  assert.match(workflow, /needs: contract/);
  assert.match(workflow, /WECOM_SECRET: \$\{\{ secrets.WECOM_SECRET \}\}/);
  assert.match(workflow, /WECOM_CORP_ID: \$\{\{ secrets.WECOM_CORP_ID \}\}/);
  assert.equal(
    (
      workflow.match(
        /WECOM_SPACE_ID: \$\{\{ vars.WECOM_SPACE_ID \|\| secrets.WECOM_SPACE_ID \}\}/g,
      ) || []
    ).length,
    2,
  );
  assert.equal(
    (
      workflow.match(
        /WECOM_FOLDER_ID: \$\{\{ vars.WECOM_FOLDER_ID \|\| secrets.WECOM_FOLDER_ID \}\}/g,
      ) || []
    ).length,
    2,
  );
  assert.match(
    workflow,
    /SYNC_ENABLED: \$\{\{ vars.WECOM_SYNC_ENABLED \|\| secrets.WECOM_SYNC_ENABLED \}\}/,
  );
  assert.match(workflow, /if:.*needs.contract.outputs.run_sync == 'yes'/);
  assert.match(workflow, /echo 'run_sync=yes'/);
  assert.doesNotMatch(workflow, /if:.*secrets\./);
  assert.match(workflow, /vars.WECOM_SYNC_RUNNER \|\| 'ubuntu-24.04'/);
  assert.match(workflow, /if: always\(\)/);
  assert.match(workflow, /wecom-release-verification/);
  assert.doesNotMatch(workflow, /wecom-cli|auth init|set -x/);
});

test("下载和上传使用 GitLab 同一安装包选择器且下载有重试", async () => {
  const workflow = await read(".github/workflows/wecom-release-sync.yml");
  const script = await read("scripts/sync-wecom-release.mjs");
  assert.match(workflow, /selectGitLabReleaseAssets/);
  assert.match(script, /selectGitLabReleaseAssets/);
  assert.match(workflow, /for attempt in 1 2 3 4/);
  assert.match(workflow, /gh release download.*--clobber/);
  assert.match(workflow, /node scripts\/wecom-release-proxy.mjs/);
  assert.doesNotMatch(workflow, /--pattern ['"]\*['"]/);
});

test("固定代理配置只从 Secret 注入，上传前先探测出口，凭据不写入 workflow", async () => {
  const workflow = await read(".github/workflows/wecom-release-sync.yml");
  assert.equal(
    (workflow.match(/WECOM_PROXY_CONFIG: \$\{\{ secrets.WECOM_PROXY_CONFIG \}\}/g) || []).length,
    2,
  );
  assert.match(workflow, /node scripts\/wecom-release-proxy.mjs --probe-only/);
  assert.ok(
    workflow.indexOf("--probe-only") < workflow.indexOf("Download the three release installers"),
  );
  assert.doesNotMatch(workflow, /uuid:|public-key:|skip-cert-verify:\s*true/);
});

test("手动权限诊断不下载安装包，使用独立只读入口并保留报告", async () => {
  const workflow = await read(".github/workflows/wecom-release-sync.yml");
  const wrapper = await read("scripts/wecom-release-proxy.mjs");
  assert.match(workflow, /inspect_only:\s+description:.*\s+type: boolean\s+default: false/);
  assert.match(
    workflow,
    /name: Download the three release installers with retries\s+if: inputs.inspect_only != true/,
  );
  assert.match(workflow, /WECOM_INSPECT_ONLY: \$\{\{ inputs.inspect_only \|\| false \}\}/);
  assert.match(wrapper, /wecom-release-diagnostics\.mjs/);
});

test("桌面公开成功后显式派发微盘；GitLab 派发失败不阻止尝试；无配置时关闭自动派发", async () => {
  const workflow = await read(".github/workflows/desktop-release.yml");
  const publish = workflow.indexOf('gh release edit "$tag"');
  const gitlab = workflow.indexOf("- name: Dispatch the GitLab release sync");
  const wecom = workflow.indexOf("- name: Dispatch the WeCom release sync");
  assert.ok(publish > 0 && gitlab > publish && wecom > gitlab);
  assert.match(workflow, /id: publish_release/);
  assert.match(
    workflow.slice(wecom),
    /if:.*!cancelled\(\).*steps.publish_release.outcome == 'success'/,
  );
  assert.match(
    workflow.slice(wecom),
    /SYNC_ENABLED: \$\{\{ vars.WECOM_SYNC_ENABLED \|\| secrets.WECOM_SYNC_ENABLED \}\}/,
  );
  assert.match(workflow.slice(wecom), /if \[\[ "\$SYNC_ENABLED" != true \]\]; then/);
  assert.match(workflow.slice(wecom), /gh workflow run wecom-release-sync.yml/);
  assert.match(workflow.slice(wecom), /-f tag="v\$\{version\}"/);
  assert.match(workflow, /scripts\/test\/wecom-release-\*\.test\.mjs/);
});
