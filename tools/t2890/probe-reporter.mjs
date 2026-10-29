// T-2890 probe (temporary, wip branch only): one JSON line per test event, to see what the parent runner receives per file.
export default async function* probe(source) {
  for await (const ev of source) {
    const d = ev.data ?? {};
    yield `${JSON.stringify({ t: ev.type, n: d.nesting, f: d.file, name: typeof d.name === 'string' ? d.name.slice(0, 60) : undefined, c: d.count, m: typeof d.message === 'string' ? d.message.slice(0, 80) : undefined })}\n`;
  }
}
