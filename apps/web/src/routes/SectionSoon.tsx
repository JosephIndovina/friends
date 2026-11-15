import { useGlow } from "../lib/glow";

export function SectionSoon({ title, body }: { title: string; body: string }) {
  useGlow(null);
  return (
    <section className="section-head">
      <h1>{title}</h1>
      <p>{body}</p>
    </section>
  );
}
