import * as React from "react";
import { Dialog as Primitive } from "@base-ui/react/dialog";
import { X } from "@phosphor-icons/react";
import { Button } from "./button";
import { cn } from "#lib/utils";
export const Dialog = Primitive.Root;
export const DialogTitle = Primitive.Title;
export const DialogDescription = Primitive.Description;
export function DialogContent({ children, className, ...props }: Primitive.Popup.Props) {
  return (
    <Primitive.Portal>
      <Primitive.Backdrop className="fixed inset-0 z-50 bg-overlay" />
      <Primitive.Popup
        className={cn(
          "fixed left-1/2 top-1/2 z-50 flex max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-xl -translate-x-1/2 -translate-y-1/2 flex-col gap-4 overflow-y-auto rounded-sm border bg-popover p-4 text-popover-foreground shadow-overlay",
          className,
        )}
        {...props}
      >
        {children}
        <Primitive.Close
          render={<Button variant="ghost" size="icon-sm" className="absolute right-3 top-3" />}
          aria-label="Close dialog"
        >
          <X aria-hidden="true" />
        </Primitive.Close>
      </Primitive.Popup>
    </Primitive.Portal>
  );
}
export function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("flex flex-col gap-2 pr-10", className)} {...props} />;
}
export function DialogFooter({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("flex flex-wrap justify-end gap-2", className)} {...props} />;
}
