import { useState } from "react";

/** Linear's logomark, the path only; the rail and the avatar draw it in
 *  boxes of their own */
export const LINEAR_PATH =
  "M2.886 4.18A11.982 11.982 0 0 1 11.99 0C18.624 0 24 5.376 24 12.009c0 3.64-1.62 6.903-4.18 9.105L2.887 4.18ZM1.817 5.626l16.556 16.556c-.524.33-1.075.62-1.65.866L.951 7.277c.247-.575.537-1.126.866-1.65ZM.322 9.163l14.515 14.515c-.71.172-1.443.282-2.195.322L0 11.358a12 12 0 0 1 .322-2.195Zm-.17 4.862 9.823 9.824a12.02 12.02 0 0 1-9.824-9.824Z";

/** A person, as a circle: their picture when Linear has one, their initials
 *  on a hue hashed from their name when it doesn't. The hue is stable per
 *  person, so the same name is the same colour in every place it appears.
 *
 *  A picture that fails to load falls back to the initials rather than to a
 *  broken image: these are remote URLs on Linear's CDN, and the network they
 *  need is not the network the panel needed to get this far. */
export function Avatar({
  name,
  avatar,
  initials,
  className,
}: {
  name: string;
  avatar: string | null;
  initials: string | null;
  className: string;
}) {
  const [broken, setBroken] = useState(false);

  // Comments Linear itself writes — an automation, a state change — come
  // from a user with no picture called "Linear". Its initials are not a
  // person's; the logomark is what says who this is.
  if (name === "Linear" && !avatar)
    return (
      <span className={`${className} linear`} title={name}>
        <svg viewBox="-3 -3 30 30" width="100%" height="100%" fill="currentColor">
          <path d={LINEAR_PATH} />
        </svg>
      </span>
    );

  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 360;

  if (avatar && !broken)
    return (
      <img className={className} src={avatar} alt={name} title={name} loading="lazy" onError={() => setBroken(true)} />
    );
  return (
    <span
      className={className}
      title={name}
      style={{ background: `oklch(0.45 0.09 ${h} / 0.5)`, color: `oklch(0.92 0.05 ${h})` }}
    >
      {initials ?? name.slice(0, 2).toUpperCase()}
    </span>
  );
}
