import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@onecli/ui/components/card";
import { APP_VERSION } from "@/lib/version";

export const BuildVersionCard = () => (
  <Card>
    <CardHeader>
      <CardTitle>Build version</CardTitle>
      <CardDescription>
        The OneCLI version this instance is running. Include it when reporting
        issues so the behavior can be matched to a release.
      </CardDescription>
    </CardHeader>
    <CardContent>
      <div className="inline-flex items-center rounded-md border px-3 py-2">
        <code className="font-mono text-sm">v{APP_VERSION}</code>
      </div>
    </CardContent>
  </Card>
);
