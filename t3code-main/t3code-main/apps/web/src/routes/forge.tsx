import { createFileRoute } from "@tanstack/react-router";

import { ForgePage } from "../components/forge/ForgePage";

export const Route = createFileRoute("/forge")({
  component: ForgePage,
});
