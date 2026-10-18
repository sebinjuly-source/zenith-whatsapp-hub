// Call one MCP tool like an AI client would. Usage: node scripts/mcp-call.mjs <tool> '<json args>' [baseUrl]
import 'dotenv/config';
const [tool, args = '{}', base = 'https://zenith-whatsapp-hub.onrender.com'] = process.argv.slice(2);
const res = await fetch(`${base}/mcp/${process.env.API_KEY}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: JSON.parse(args) } }),
});
const j = await res.json();
console.log(j.result ? j.result.content.map((c) => c.text).join('\n') : JSON.stringify(j));
