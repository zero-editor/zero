import { useState } from "react";

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
