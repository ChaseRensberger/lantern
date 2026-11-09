import * as React from "react";
import { Input as InputPrimitive } from "@base-ui/react/input";
import { cn } from "#lib/utils";
export function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <InputPrimitive
      type={type}
      data-slot="input"
      className={cn(
        "h-9 w-full min-w-0 rounded-[var(--radius)] border border-input bg-transparent px-2.5 py-1 text-base outline-none placeholder:text-muted-foreground disabled:opacity-50 aria-invalid:border-destructive md:text-sm",
        className,
      )}
      {...props}
    />
  );
}
