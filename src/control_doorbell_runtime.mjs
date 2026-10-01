import { createHash } from "node:crypto";
import { runOnce, validateLease, watcherRunning } from "./github_authority_resident.mjs";

export const RUNTIME_ARTIFACT_MAPPING = Object.freeze({
  adapter_source: "src/control_doorbell_runtime.mjs",
  adapter_runtime: "D:/AIWORK_RUNTIME/GPT_BROWSER_BRIDGE/control-doorbell/watcher.mjs",
  config_source: "config/control_doorbell_runtime.json",
  config_runtime: "D:/AIWORK_RUNTIME/GPT_BROWSER_BRIDGE/control-doorbell/config.json",
  semantic_core_source: "src/github_authority_resident.mjs",
  semantic_core_runtime: "D:/AIWORK_RUNTIME/GPT_BROWSER_BRIDGE/control-doorbell/github_authority_resident.mjs",
  semantic_core_blob: "1a0c818321e64ec3dd4619e563d6845124af7c2b",
});

function failClosed() {
  throw new Error("CONTROL_REQUIRED/NO_SEND");
}

function requiredText(value) {
  if (typeof value !== "string" || !value.trim()) failClosed();
  return value;
}

function commentId(value) {
  const id = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : value;
  if (typeof id !== "string" || !/^[1-9]\d*$/.test(id)) failClosed();
  return id;
}

export function selectCurrentAuthority(snapshot) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) failClosed();
  const roles = ["control", "registry", "switch"];
  const receipts = roles.map((role) => {
    const receipt = snapshot[role];
    if (!receipt || typeof receipt !== "object" || Array.isArray(receipt) || receipt.switch_conflict !== false) failClosed();
    return {
      github_comment_id: commentId(receipt.github_comment_id),
      control_generation: requiredText(receipt.control_generation),
      active_control_conversation_id: requiredText(receipt.active_control_conversation_id),
      producer_admission_comment_ids: receipt.producer_admission_comment_ids ?? [],
    };
  });
  const [control, registry, activeSwitch] = receipts;
  if (receipts.some((receipt) => receipt.control_generation !== control.control_generation
    || receipt.active_control_conversation_id !== control.active_control_conversation_id)) failClosed();
  const admissions = new Set();
  for (const receipt of receipts) {
    if (!Array.isArray(receipt.producer_admission_comment_ids)) failClosed();
    for (const id of receipt.producer_admission_comment_ids) admissions.add(commentId(id));
  }
  return {
    switch_conflict: false,
    control_generation: control.control_generation,
    active_control_conversation_id: control.active_control_conversation_id,
    current_start_receipt: control.github_comment_id,
    current_registry_receipt: registry.github_comment_id,
    active_switch_receipt: activeSwitch.github_comment_id,
    producer_admission_comment_ids: [...admissions].sort((a, b) => BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0),
  };
}

export function hasCurrentProducerAdmission(source, authority, receipt) {
  try {
    const id = commentId(source?.producer_admission_comment_id);
    if (!authority?.producer_admission_comment_ids?.includes(id)
      || commentId(receipt?.github_comment_id) !== id
      || receipt.control_generation !== authority.control_generation
      || receipt.active_control_conversation_id !== authority.active_control_conversation_id
      || source.control_generation !== authority.control_generation
      || source.active_control_conversation_id !== authority.active_control_conversation_id) return false;
    return ["source_repo", "source_issue", "source_comment_id"].every((field) =>
      source[field] === undefined || source[field] === receipt[field]);
  } catch {
    return false;
  }
}

export function validateConfig(config) {
  const issues = config?.authority_issue_numbers;
  if (config?.schema_version !== 1
    || config.repository_full_name !== "D22977/gpt-browser-bridge"
    || !issues || issues.control !== 88 || issues.registry !== 43 || issues.switch !== 81
    || config.source_issue_number !== 162
    || !Number.isSafeInteger(config.poll_interval_min_ms) || config.poll_interval_min_ms <= 0
    || !Number.isSafeInteger(config.poll_interval_max_ms) || config.poll_interval_max_ms < config.poll_interval_min_ms
    || !Number.isSafeInteger(config.poll_interval_ms)
    || config.poll_interval_ms < config.poll_interval_min_ms || config.poll_interval_ms > config.poll_interval_max_ms
    || !Number.isSafeInteger(config.heartbeat_max_age_ms) || config.heartbeat_max_age_ms <= 0
    || config.transport_capability !== "herdr-minimal-github-pointer"
    || JSON.stringify(config.artifact_mapping) !== JSON.stringify(RUNTIME_ARTIFACT_MAPPING)) failClosed();
  return config;
}

export function getTriggerContractHash(config) {
  validateConfig(config);
  return createHash("sha256").update(JSON.stringify([config.schema_version, config.transport_capability])).digest("hex");
}

function sameAuthority(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function createControlDoorbellRuntime({ config, github, residentInstanceId, now, sendPointer }) {
  validateConfig(config);
  requiredText(residentInstanceId);
  if (typeof now !== "function" || typeof sendPointer !== "function"
    || !github || typeof github.readAuthoritySnapshot !== "function"
    || typeof github.listReceipts !== "function" || typeof github.listSourceEvents !== "function"
    || typeof github.readHeartbeat !== "function" || typeof github.getReceipt !== "function"
    || typeof github.publishReceipt !== "function") failClosed();
  const triggerContractHash = getTriggerContractHash(config);

  async function readAuthority() {
    return selectCurrentAuthority(await github.readAuthoritySnapshot(config.authority_issue_numbers));
  }

  return {
    pollIntervalMs: config.poll_interval_ms,
    async poll() {
      try {
        const authority = await readAuthority();
        const currentTime = requiredText(now());
        const receipts = await github.listReceipts();
        if (!Array.isArray(receipts)) failClosed();
        const leases = receipts.filter((receipt) => receipt?.type === "LOCAL_CONTROL_RESIDENT_LEASE_V1"
          && receipt.control_generation === authority.control_generation
          && receipt.trigger_contract_hash === triggerContractHash);
        if (leases.length !== 1) failClosed();
        const lease = validateLease(leases[0], authority, receipts, currentTime);
        const heartbeat = await github.readHeartbeat();
        if (!watcherRunning(heartbeat, lease, authority, currentTime, config.heartbeat_max_age_ms)) failClosed();

        const sourceEvents = await github.listSourceEvents(config.source_issue_number);
        if (!Array.isArray(sourceEvents)) failClosed();
        const authorizedEvents = [];
        for (const source of sourceEvents) {
          let admission;
          try { admission = await github.getReceipt(commentId(source?.producer_admission_comment_id)); }
          catch { admission = null; }
          if (hasCurrentProducerAdmission(source, authority, admission)) authorizedEvents.push(source);
        }
        if (sourceEvents.length && !authorizedEvents.length) return { state: "CONTROL_REQUIRED/NO_SEND" };

        return await runOnce({
          github: {
            readAuthority,
            listReceipts: () => github.listReceipts(),
            listSourceEvents: async () => authorizedEvents,
            getReceipt: (id) => github.getReceipt(id),
            publishReceipt: (receipt) => github.publishReceipt(receipt),
          },
          residentInstanceId,
          triggerContractHash,
          now: currentTime,
          transport: async (pointer) => {
            const source = authorizedEvents.find((event) => String(event.source_comment_id) === String(pointer.source_comment_id));
            if (!source || !sameAuthority(authority, await readAuthority())) failClosed();
            const admission = await github.getReceipt(commentId(source.producer_admission_comment_id));
            if (!hasCurrentProducerAdmission(source, authority, admission)) failClosed();
            const result = await sendPointer({
              source_repo: pointer.source_repo,
              source_issue: pointer.source_issue,
              source_comment_id: pointer.source_comment_id,
              wake_request_comment_id: pointer.wake_request_comment_id,
            });
            if (!sameAuthority(authority, await readAuthority())) failClosed();
            return result;
          },
        });
      } catch {
        return { state: "CONTROL_REQUIRED/NO_SEND" };
      }
    },
  };
}
