import { getHostContextRecords } from "@/agent/host-context-records";
import { sendMessageStreamWithBackend } from "@/agent/message";
import {
  getMessageTransportOwner,
  getTurnMessageDispatch,
  setTurnMessageTransport,
} from "@/agent/message-transport-owner";

/** Only native submit/queue orchestration supplies humanOtid. Mod sends and
 * automated continuations use the ordinary message path, never this provenance.
 */
export async function sendTuiMessageStream(
  conversationId: string,
  messages: Parameters<typeof sendMessageStreamWithBackend>[2],
  options: Parameters<typeof sendMessageStreamWithBackend>[3] & {
    humanOtid?: string;
  },
  requestOptions?: Parameters<typeof sendMessageStreamWithBackend>[4],
) {
  const { humanOtid, ...sendOptions } = options;
  if (humanOtid && !options.agentId)
    throw new Error("Human context requires an agent identity");
  const capturedDispatch =
    !humanOtid && requestOptions?.signal
      ? getTurnMessageDispatch(requestOptions.signal)
      : undefined;
  const transport =
    capturedDispatch ??
    (await getHostContextRecords().transport(
      { agentId: options.agentId ?? "", conversationId },
      humanOtid,
      requestOptions?.signal,
    ));
  const owner = getMessageTransportOwner(transport);
  if (owner && requestOptions?.signal)
    setTurnMessageTransport(
      requestOptions.signal,
      owner.recovery,
      owner.dispatch,
      humanOtid,
    );
  return sendMessageStreamWithBackend(
    transport,
    conversationId,
    messages,
    sendOptions,
    requestOptions,
  );
}
