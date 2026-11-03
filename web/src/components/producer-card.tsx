import { Section } from "@/components/ui";
import type { ProducerFields } from "@/lib/quote-terms";

/** Who to chase (UX-074): on the pages the desk's Chase tasks open, with the reference in the email's subject. */
export function ProducerCard({ producer, subject }: { producer: ProducerFields; subject: string }) {
  const mailto = producer.email && `mailto:${producer.email.split("@").map(encodeURIComponent).join("@")}?subject=${encodeURIComponent(subject)}`;
  return (
    <Section title="Producer">
      <div className="space-y-0.5 p-4 text-sm">
        <p className="font-medium">{producer.agency || "Not on file"}</p>
        {producer.contact && <p>{producer.contact}</p>}
        {mailto && <p><a href={mailto} className="text-indigo-600 hover:underline">{producer.email}</a></p>}
        {producer.phone && <p><a href={`tel:${producer.phone.replace(/[^\d+]/g, "")}`} className="text-indigo-600 hover:underline">{producer.phone}</a></p>}
      </div>
    </Section>
  );
}
