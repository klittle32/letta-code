import type { Backend } from "@/backend/backend";
/** Narrow principal-bound recovery surface; conversation-wide cancellation is
 * deliberately absent because it can target a different/newer run. */
export type MessageRecoveryTransport = Pick<
  Backend,
  | "retrieveRun"
  | "streamConversationMessages"
  | "streamRunMessages"
  | "cancelRun"
>;
type Owner = {
  cacheOwner: object;
  recovery: MessageRecoveryTransport;
  dispatch?: Pick<Backend, "createConversationMessageStream">;
  humanOtid?: string;
};
const owners = new WeakMap<object, Owner>();
export function setMessageTransportOwner(
  transport: object,
  cacheOwner: object,
  recovery: MessageRecoveryTransport,
  dispatch?: Owner["dispatch"],
): void {
  owners.set(transport, { cacheOwner, recovery, dispatch });
}
export function getMessageTransportOwner(transport: object) {
  return owners.get(transport);
}
const turns = new WeakMap<AbortSignal, Owner>();
export function setTurnMessageTransport(
  signal: AbortSignal,
  recovery: MessageRecoveryTransport,
  dispatch?: Owner["dispatch"],
  humanOtid?: string,
): void {
  turns.set(signal, {
    cacheOwner: dispatch ?? recovery,
    recovery,
    dispatch,
    humanOtid: humanOtid ?? turns.get(signal)?.humanOtid,
  });
}
export function getTurnMessageTransport(signal: AbortSignal) {
  return turns.get(signal)?.recovery;
}

export function getTurnMessageDispatch(signal: AbortSignal) {
  return turns.get(signal)?.dispatch;
}

export function assertTurnReplayAllowed(signal: AbortSignal): void {
  const owner = turns.get(signal);
  if (owner)
    throw new Error(
      `Passive context submission ${owner.humanOtid ?? "unknown"} may have been accepted; automatic request replay and approval rebuild are fenced. Inspect conversation.context.submissions() and reconcile the original submission before redelivery.`,
    );
}
