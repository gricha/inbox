import { useState } from "react";

// Logins whose picture didn't load, so a row drawn again doesn't try (and flash) it again.
const failed = new Set<string>();

// A person's GitHub picture before their name, the size of the words beside it; gone, leaving no box, if it doesn't load.
export function Avatar({ login }: { login: string }) {
  const [, redraw] = useState(0);
  if (failed.has(login)) return null;
  return (
    <img
      className="avatar"
      src={`https://avatars.githubusercontent.com/${encodeURIComponent(login)}?s=40`}
      alt=""
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => {
        failed.add(login);
        redraw((n) => n + 1);
      }}
    />
  );
}
