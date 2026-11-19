// Capture application writes before the terminal translates newlines or ANSI sequences.
for (const channel of ["stdout", "stderr"] as const) {
  const stream = process[channel];
  stream.write = new Proxy(stream.write, {
    apply(write, receiver, args) {
      const [chunk] = args;
      const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      process.send?.([channel, text]);
      return Reflect.apply(write, receiver, args);
    },
  });
}
