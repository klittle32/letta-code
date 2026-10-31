/** Preserve exact IDs across normal terminal transitions, never across unobserved recovery. */
export function observeTuiRunStream<T extends AsyncIterable<unknown>>(
  stream: T,
  observe: (runId: string | undefined) => void,
): T {
  // Recovery request metadata is WeakMap-keyed by the original stream. A Proxy
  // changes that identity, so observe its iterator without replacing the stream.
  const iterate = stream[Symbol.asyncIterator].bind(stream);
  const descriptor = Object.getOwnPropertyDescriptor(
    stream,
    Symbol.asyncIterator,
  );
  Object.defineProperty(stream, Symbol.asyncIterator, {
    configurable: true,
    value: async function* () {
      let terminal = false;
      let completed = false;
      try {
        for await (const chunk of { [Symbol.asyncIterator]: iterate }) {
          if (chunk && typeof chunk === "object") {
            if ("run_id" in chunk && typeof chunk.run_id === "string")
              observe(chunk.run_id);
            if (
              "message_type" in chunk &&
              chunk.message_type === "stop_reason" &&
              "stop_reason" in chunk
            ) {
              terminal =
                typeof chunk.stop_reason === "string" &&
                chunk.stop_reason !== "error";
            }
          }
          yield chunk;
        }
        completed = true;
      } finally {
        if (descriptor)
          Object.defineProperty(stream, Symbol.asyncIterator, descriptor);
        else Reflect.deleteProperty(stream, Symbol.asyncIterator);
        // Truncation/errors may trigger an internally resumed stream. Its
        // inferred/lookup IDs are not evidence for this strict host API.
        if (!completed || !terminal) observe(undefined);
      }
    },
  });
  return stream;
}
