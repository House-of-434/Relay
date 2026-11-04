import { Renderer } from "@openuidev/react-lang";
import { relayLibrary } from "@/lib/openui/library";
import { useState } from "react";

interface OpenUIRendererProps {
  code: string;
  streaming?: boolean;
}

function classifyErrors(errors: unknown): { warnings: any[]; errors: any[] } {
  const arr = Array.isArray(errors) ? errors : [];
  const warnings = arr.filter((e: any) => e?.code === "excess-args" || e?.code === "orphaned");
  const errorsList = arr.filter((e: any) => e?.code !== "excess-args" && e?.code !== "orphaned");
  return { warnings, errors: errorsList };
}

export function OpenUIRenderer({ code, streaming = false }: OpenUIRendererProps) {
  const [errors, setErrors] = useState<unknown>(null);

  const { warnings, errors: hardErrors } = classifyErrors(errors);

  return (
    <div>
      <Renderer
        response={code}
        library={relayLibrary}
        isStreaming={streaming}
        onError={(err) => {
          console.error("[OpenUI] parse/render errors:", err);
          setErrors(err);
        }}
      />
      {hardErrors.length > 0 && !streaming ? (
        <details className="mt-2 text-xs text-red-600">
          <summary>OpenUI errors ({hardErrors.length})</summary>
          <pre className="mt-1 overflow-auto whitespace-pre-wrap">{JSON.stringify(hardErrors, null, 2)}</pre>
        </details>
      ) : null}
      {warnings.length > 0 && !streaming ? (
        <details className="mt-2 text-xs text-amber-600">
          <summary>OpenUI warnings ({warnings.length})</summary>
          <pre className="mt-1 overflow-auto whitespace-pre-wrap">{JSON.stringify(warnings, null, 2)}</pre>
        </details>
      ) : null}
    </div>
  );
}

export function OpenUIBlock({ code, streaming = false }: OpenUIRendererProps) {
  return <OpenUIRenderer code={code} streaming={streaming} />;
}
