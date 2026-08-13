import { addCommandEvent, upsertAutomationAlert } from "../db";
import { resolveNotifyChannel } from "../notify";
import type { WorkerConfig } from "../config";
import type { BrowserBlocker } from "./blockerDetection";

export async function reportBrowserBlocker(input: {
  commandId: string;
  userId: string;
  blocker: BrowserBlocker;
  cfg: WorkerConfig;
}) {
  const alert = await upsertAutomationAlert({
    userId: input.userId,
    commandId: input.commandId,
    kind: input.blocker.kind,
    site: input.blocker.site,
    message: input.blocker.message,
    pageUrl: input.blocker.pageUrl,
    metadataJson: { evidence: input.blocker.evidence },
  });
  await addCommandEvent(
    input.commandId,
    "browser_human_intervention_required",
    input.blocker.message,
    {
      alertId: alert.id,
      kind: input.blocker.kind,
      site: input.blocker.site,
      pageUrl: input.blocker.pageUrl,
      evidence: input.blocker.evidence,
    },
  );
  await resolveNotifyChannel(input.cfg).notifyBrowserBlocked({
    site: input.blocker.site,
    kind: input.blocker.kind,
    message: input.blocker.message,
  });
  return alert;
}
