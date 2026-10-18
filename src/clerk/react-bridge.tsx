"use client";

import { useEffect } from "react";
import { useClerk } from "@clerk/react";
import type { ClerkSessionSource } from "./source.js";

export function ReactClerkSessionBridge({ source }: { source: ClerkSessionSource }): null {
  const clerk = useClerk();
  useEffect(() => source.attach(clerk), [clerk, source]);
  return null;
}
