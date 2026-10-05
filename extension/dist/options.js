import { connect, DEFAULT_SERVICE_URL, isLoopback, NOT_LOCAL, readSettings, writeSettings } from "./settings.js";
const $ = (id) => document.getElementById(id);
const url = $("url"), result = $("result");
const say = (line, bad) => { result.textContent = line; result.classList.toggle("bad", bad); };
// Save the address, then pair and ask the service what it can do. Nothing is pasted: the code
// comes from the service itself.
$("connect").addEventListener("click", async () => {
    const service_url = url.value.trim().replace(/\/+$/, "");
    if (!isLoopback(service_url + "/")) {
        say(NOT_LOCAL, true);
        return;
    }
    await writeSettings({ service_url });
    const { ok, line } = await connect(service_url);
    say(line, !ok);
});
void readSettings().then(s => { url.value = s?.service_url ?? DEFAULT_SERVICE_URL; });
