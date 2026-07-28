import type { Metadata } from "next";
import { CodeverApp } from "./CodeverApp";

export const metadata: Metadata = {
  title: "Your agents, anywhere",
  description: "A secure, end-to-end encrypted workspace for coding agents.",
};

export default function Home() {
  return <CodeverApp />;
}
