export async function api(path, options) {
  let resp;
  try {
    resp = await fetch(path, options);
  } catch {
    throw new Error("Không kết nối được tới backend");
  }
  if (!resp.ok) {
    let detail = `Lỗi ${resp.status}`;
    try {
      const data = await resp.json();
      if (typeof data.detail === "string") detail = data.detail;
      else if (Array.isArray(data.detail)) detail = data.detail.map((d) => d.msg).join("; ");
    } catch { /* keep the status text */ }
    throw new Error(detail);
  }
  return resp;
}

export const getJson = async (path) => (await api(path)).json();

export const postJson = (path, body) =>
  api(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

export function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}
