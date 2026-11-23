// The page around the demo: hints that take the demo somewhere, Start over, and Copy.
const frame = document.querySelector<HTMLIFrameElement>("#demo");

for (const b of document.querySelectorAll<HTMLButtonElement>("[data-go]")) {
  b.addEventListener("click", () => {
    const win = frame?.contentWindow;
    if (!win || !b.dataset.go) return;
    win.location.hash = b.dataset.go;
    frame.focus();
  });
}

document.querySelector("[data-reset]")?.addEventListener("click", () => {
  const win = frame?.contentWindow;
  if (!win) return;
  win.history.replaceState(null, "", "/demo/");
  win.location.reload();
});

const copy = document.querySelector<HTMLButtonElement>("[data-copy]");
copy?.addEventListener("click", () => {
  const text = document.querySelector("#cmd")?.textContent ?? "";
  void navigator.clipboard.writeText(text).then(() => {
    copy.textContent = "Copied";
    return setTimeout(() => {
      copy.textContent = "Copy";
    }, 1500);
  });
});
