import { cva } from "class-variance-authority";
export const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center rounded-[var(--radius)] border border-transparent bg-clip-padding text-sm font-medium whitespace-nowrap transition-colors duration-150 outline-none select-none focus-visible:border-ring disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "border-link bg-primary text-primary-foreground hover:bg-primary-hover",
        outline:
          "border-input bg-background hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground",
        secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        ghost: "hover:bg-muted hover:text-foreground",
        destructive: "bg-destructive/10 text-destructive hover:bg-destructive/20",
        link: "text-link underline underline-offset-4",
      },
      size: {
        default: "h-9 gap-1.5 px-2.5",
        sm: "h-8 gap-1.5 px-2.5",
        icon: "size-9",
        "icon-sm": "size-8",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);
