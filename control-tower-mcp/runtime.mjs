import { isDeepStrictEqual } from "node:util";

const blocked = (code) => ({ state: "BLOCKED", code });
const unavailable = (code) => async () => blocked(code);

function port(ports, name, code) {
  return typeof ports?.[name] === "function" ? ports[name] : unavailable(code);
}

export function createRuntimeServices(ports = {}) {
  const publishReceipt = ports?.publishReceipt;
  const readReceipt = ports?.readReceipt;

  return {
    bootstrapProject: port(ports, "bootstrapProject", "BLOCKED_GITHUB_READER_UNAVAILABLE"),
    readControlState: port(ports, "readControlState", "BLOCKED_GITHUB_READER_UNAVAILABLE"),
    writeReceipt: async (input) => {
      if (typeof publishReceipt !== "function" || typeof readReceipt !== "function") {
        return blocked("BLOCKED_RECEIPT_PUBLISHER_OR_READBACK_UNAVAILABLE");
      }

      let expected;
      try {
        expected = structuredClone(input);
      } catch {
        return blocked("BLOCKED_RECEIPT_PAYLOAD_INVALID");
      }

      let published;
      try {
        published = await publishReceipt(structuredClone(expected));
      } catch {
        return blocked("BLOCKED_RECEIPT_PUBLISH_FAILED");
      }
      const receiptId = published?.receipt_id;
      if (typeof receiptId !== "string" || receiptId.length === 0) {
        return blocked("BLOCKED_RECEIPT_PUBLISH_RESULT_INVALID");
      }

      let readBack;
      try {
        readBack = await readReceipt({ ...structuredClone(expected), receipt_id: receiptId });
      } catch {
        return blocked("BLOCKED_RECEIPT_READBACK_FAILED");
      }

      const matches = readBack?.receipt_id === receiptId
        && readBack?.repo === expected.repo
        && readBack?.issue === expected.issue
        && readBack?.protocol === expected.protocol
        && isDeepStrictEqual(readBack?.payload, expected.payload);
      if (!matches) return blocked("BLOCKED_RECEIPT_READBACK_MISMATCH");

      return { state: "PASS", receipt_id: receiptId, read_back: true };
    },
    inspectWorkerWake: port(ports, "inspectWorkerWake", "BLOCKED_WORKER_WAKE_INVENTORY_UNAVAILABLE"),
    wakeWorker: port(ports, "wakeWorker", "BLOCKED_WORKER_WAKE_NOT_ADMITTED"),
    runWorkerWakeCanary: port(ports, "runWorkerWakeCanary", "BLOCKED_WORKER_CANARY_NOT_ADMITTED"),
    workerStatus: port(ports, "workerStatus", "BLOCKED_WORKER_STATUS_UNAVAILABLE"),
    inspectReviewerRoutes: port(ports, "inspectReviewerRoutes", "BLOCKED_REVIEWER_ROUTE_UNAVAILABLE"),
    launchFreshReviewer: port(ports, "launchFreshReviewer", "BLOCKED_REVIEWER_TRANSPORT_NOT_ADMITTED"),
    dispatchBatch: port(ports, "dispatchBatch", "BLOCKED_BATCH_PRECONDITIONS_UNMET"),
    recoverWakeConsumer: port(ports, "recoverWakeConsumer", "BLOCKED_WAKE_CONSUMER_NOT_ADMITTED"),
    selfTest: port(ports, "selfTest", "BLOCKED_REQUIRED_ADAPTERS_UNAVAILABLE"),
  };
}
