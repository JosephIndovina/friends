export function Avatar({ src, name, size = 32 }: { src: string; name: string; size?: number }) {
  return <img className="avatar" src={src} alt="" width={size} height={size} loading="lazy" title={name} />;
}
