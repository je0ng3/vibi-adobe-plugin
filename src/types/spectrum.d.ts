import type { DetailedHTMLProps, HTMLAttributes } from "react";

type SpElement<E = Record<string, unknown>> = DetailedHTMLProps<
  HTMLAttributes<HTMLElement> & E,
  HTMLElement
>;

declare global {
  namespace JSX {
    interface IntrinsicElements {
      "sp-theme": SpElement<{
        color?: "light" | "lightest" | "dark" | "darkest";
        scale?: "medium" | "large";
        system?: "spectrum" | "express";
      }>;
      "sp-button": SpElement<{
        variant?: "accent" | "primary" | "secondary" | "negative" | "cta";
        treatment?: "fill" | "outline";
        size?: "s" | "m" | "l" | "xl";
        disabled?: boolean;
        quiet?: boolean;
        pending?: boolean;
      }>;
      "sp-textfield": SpElement<{
        value?: string;
        placeholder?: string;
        type?: "text" | "password" | "email" | "number" | "tel" | "url";
        disabled?: boolean;
        invalid?: boolean;
        quiet?: boolean;
        size?: "s" | "m" | "l" | "xl";
      }>;
      "sp-field-label": SpElement<{
        for?: string;
        required?: boolean;
        size?: "s" | "m" | "l" | "xl";
      }>;
      "sp-progress-bar": SpElement<{
        progress?: number;
        indeterminate?: boolean;
        label?: string;
        "side-label"?: boolean;
        size?: "s" | "m" | "l" | "xl";
        "over-background"?: boolean;
      }>;
      "sp-help-text": SpElement<{
        variant?: "neutral" | "negative";
        size?: "s" | "m" | "l" | "xl";
      }>;
    }
  }
}

export {};
