const guarded = new WeakSet();
function closeStream(client) {
  try { client.destroy?.(); } catch { /* 已损坏的连接不能影响其他订阅或运行。 */ }
}
function guardStream(client) {
  if (guarded.has(client)) return;
  guarded.add(client);
  client.once?.('error', () => closeStream(client));
}
function writeStream(client, value) {
  guardStream(client);
  if (client.destroyed || client.writableEnded || client.writableLength > 256 * 1024) { closeStream(client); return false; }
  try { client.write(value, error => { if (error) closeStream(client); }); return true; }
  catch { closeStream(client); return false; }
}
function endStream(client) {
  guardStream(client);
  try { client.end(); } catch { closeStream(client); }
}
module.exports = { writeStream, endStream, guardStream };
