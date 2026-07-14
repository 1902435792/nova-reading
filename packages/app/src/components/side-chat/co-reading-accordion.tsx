import { cn } from "@/lib/utils";
import { type ReactNode, createContext, useContext } from "react";

type AccordionContextValue = {
  value: React.Key | null;
  onValueChange: (value: React.Key | null) => void;
};

const AccordionContext = createContext<AccordionContextValue | null>(null);
const ItemContext = createContext<React.Key | null>(null);

export function CoReadingAccordion({
  children,
  className,
  expandedValue,
  onValueChange,
}: {
  children: ReactNode;
  className?: string;
  expandedValue: React.Key | null;
  onValueChange: (value: React.Key | null) => void;
}) {
  return (
    <AccordionContext.Provider value={{ value: expandedValue, onValueChange }}>
      <div className={className}>{children}</div>
    </AccordionContext.Provider>
  );
}

export function CoReadingAccordionItem({
  value,
  children,
  className,
}: {
  value: React.Key;
  children: ReactNode;
  className?: string;
}) {
  return (
    <ItemContext.Provider value={value}>
      <div className={cn("overflow-hidden", className)}>{children}</div>
    </ItemContext.Provider>
  );
}

export function CoReadingAccordionTrigger({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  const accordion = useContext(AccordionContext);
  const value = useContext(ItemContext);
  if (!accordion || value == null) return null;
  const expanded = accordion.value === value;
  return (
    <button
      type="button"
      className={cn("w-full", className)}
      aria-expanded={expanded}
      onClick={() => accordion.onValueChange(expanded ? null : value)}
    >
      {children}
    </button>
  );
}

export function CoReadingAccordionContent({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  const accordion = useContext(AccordionContext);
  const value = useContext(ItemContext);
  if (!accordion || accordion.value !== value) return null;
  return <div className={className}>{children}</div>;
}
