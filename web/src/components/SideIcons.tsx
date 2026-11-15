// The sidebar's icons (the owner's set, 20px), drawn in currentColor: the sidebar makes them white.
const LINE = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

function Icon({ children }: { children: React.ReactNode }) {
  return (
    <svg className="si" viewBox="0 0 20 20" aria-hidden="true" focusable="false">
      {children}
    </svg>
  );
}

// Solid, so drawn a little smaller than the line icons to look the same size.
export const InboxIcon = () => (
  <Icon>
    <path
      transform="translate(10 10) scale(0.86) translate(-10 -10)"
      fill="currentColor"
      d="m14,2H6c-2.206,0-4,1.794-4,4v8c0,2.206,1.794,4,4,4h8c2.206,0,4-1.794,4-4V6c0-2.206-1.794-4-4-4Zm2,11c0,.552-.448,1-1,1h-1.719c-.459,0-.859.312-.97.757l-.121.485c-.111.445-.511.757-.97.757h-2.438c-.459,0-.859-.312-.97-.757l-.121-.485c-.111-.445-.511-.757-.97-.757h-1.719c-.552,0-1-.448-1-1v-7c0-1.105.895-2,2-2h8c1.105,0,2,.895,2,2v7Z"
    />
  </Icon>
);

export const BlockedIcon = () => (
  <Icon>
    <path {...LINE} d="m7,7v-3c0-.5523.4477-1,1-1h4c.5523,0,1,.4477,1,1v3" />
    <path
      {...LINE}
      d="m16.4855,7.9962c-.4565-.6016-1.1721-.9962-1.9855-.9962H5.5c-1.3807,0-2.5,1.1193-2.5,2.5v4c0,1.3807,1.1193,2.5,2.5,2.5h2.3181"
    />
    <path
      fill="currentColor"
      d="m14,10c-2.2092,0-4,1.7908-4,4s1.7908,4,4,4,4-1.7909,4-4-1.7908-4-4-4Zm2.0312,5.6245c-.1982.2471-.4883.3755-.7822.3755-.2188,0-.4395-.0718-.624-.2192l-1.25-1c-.2373-.1895-.375-.4771-.375-.7808v-1.5c0-.5522.4473-1,1-1s1,.4478,1,1v1.0195l.875.6997c.4307.3447.501.9741.1562,1.4053Z"
    />
  </Icon>
);

export const MergingIcon = () => (
  <Icon>
    <line {...LINE} x1="6" y1="7" x2="6" y2="17" />
    <path {...LINE} d="m13,14c-3.866,0-7-3.134-7-7" />
    <circle {...LINE} cx="6" cy="5" r="2" />
    <circle {...LINE} cx="15" cy="14" r="2" />
  </Icon>
);

export const ArchiveIcon = () => (
  <Icon>
    <path {...LINE} fill="currentColor" d="m10,6H3v-1.5c0-.828.672-1.5,1.5-1.5h2.965c.334,0,.647.167.832.445l1.703,2.555Z" />
    <line {...LINE} x1="11.5" y1="17" x2="17" y2="11.5" />
    <path {...LINE} d="m17,8v-.5c0-.828-.672-1.5-1.5-1.5H3v8c0,1.657,1.343,3,3,3h2" />
    <line {...LINE} x1="11.5" y1="11.5" x2="17" y2="17" />
  </Icon>
);

export const SearchIcon = () => (
  <Icon>
    <line {...LINE} x1="16.5" y1="16.5" x2="12.0355" y2="12.0355" />
    <circle {...LINE} cx="8.5" cy="8.5" r="5" />
  </Icon>
);

export const SettingsIcon = () => (
  <Icon>
    <path {...LINE} fill="currentColor" d="m5.5,7h1l.474,9.475c.014.286-.213.525-.499.525h-.949c-.286,0-.514-.239-.499-.525l.474-9.475Z" />
    <line {...LINE} x1="14" y1="5" x2="14" y2="11" />
    <polygon {...LINE} points="15 5 14 7 13 5 13.5 3 14.5 3 15 5" />
    <line {...LINE} x1="17" y1="11" x2="11" y2="11" />
    <path {...LINE} d="m16,11v5c0,.552-.448,1-1,1h-2c-.552,0-1-.448-1-1v-5" />
    <path
      fill="currentColor"
      d="m7.5,2.297v2.703c0,.553-.448,1-1,1h-1c-.552,0-1-.447-1-1v-2.703c-1.463.595-2.5,2.028-2.5,3.703,0,2.206,1.794,4,4,4s4-1.794,4-4c0-1.675-1.037-3.107-2.5-3.703Z"
    />
  </Icon>
);
