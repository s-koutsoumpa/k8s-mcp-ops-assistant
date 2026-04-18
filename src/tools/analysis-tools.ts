import { z } from "zod";
import { analyzeDeployment } from "../analysis/analyzer";

export function registerAnalysisTools(server: any) {
  server.tool(
    "analyze_deployment",
    {
      namespace: z.string(),
      deploymentName: z.string(),
    },
    async ({ namespace, deploymentName }: { namespace: string; deploymentName: string }) => {
      const result = await analyzeDeployment(namespace, deploymentName);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }
  );
}