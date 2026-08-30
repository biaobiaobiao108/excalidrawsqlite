import clsx from "clsx";

import { Button } from "../Button";
import Spinner from "../Spinner";
import { t } from "../../i18n";
import { alertTriangleIcon } from "../icons";

import {
  formatMermaidParseErrorMessage,
  getMermaidSyntaxErrorGuidance,
  isMermaidCaretLine,
} from "./utils/mermaidError";

interface TTDDialogOutputProps {
  error: Error | null;
  canvasRef: React.RefObject<HTMLDivElement | null>;
  loaded: boolean;
  loading?: boolean;
  hasPreview?: boolean;
  emptyMessage?: string;
  canvasAriaLabel?: string;
  errorMessageOverride?: string;
  showErrorGuidance?: boolean;
  hideErrorDetails?: boolean;
  sourceText?: string;
  autoFixAvailable?: boolean;
  onApplyAutoFix?: () => void;
}

export const TTDDialogOutput = ({
  error,
  canvasRef,
  loaded,
  loading = false,
  hasPreview = true,
  emptyMessage,
  canvasAriaLabel,
  errorMessageOverride,
  showErrorGuidance = true,
  hideErrorDetails,
  sourceText,
  autoFixAvailable,
  onApplyAutoFix,
}: TTDDialogOutputProps) => {
  const errorMessage = error
    ? errorMessageOverride ||
      (hideErrorDetails
        ? t("chat.errors.mermaidParseError")
        : formatMermaidParseErrorMessage(error.message))
    : null;
  const syntaxGuidance =
    error && !hideErrorDetails && showErrorGuidance
      ? getMermaidSyntaxErrorGuidance(error.message, sourceText)
      : null;
  const showAutoFixButton =
    !!autoFixAvailable && !!onApplyAutoFix && !hideErrorDetails;

  const errorMessageLines = errorMessage?.split(/\r?\n/) ?? [];

  return (
    <div
      className={`ttd-dialog-output-wrapper ${
        error ? "ttd-dialog-output-wrapper--error" : ""
      }`}
    >
      {error && (
        <div
          key="error"
          data-testid="ttd-dialog-output-error"
          className="ttd-dialog-output-error"
        >
          <div className="ttd-dialog-output-error-content">
            <div className="ttd-dialog-output-error-icon">
              {alertTriangleIcon}
            </div>
            {syntaxGuidance && (
              <div className="ttd-dialog-output-error-summary">
                <div className="ttd-dialog-output-error-summary__headline">
                  {syntaxGuidance.summary}
                </div>
                <div className="ttd-dialog-output-error-summary__label">
                  Likely causes:
                </div>
                <ul className="ttd-dialog-output-error-summary__causes">
                  {syntaxGuidance.likelyCauses.map((cause) => (
                    <li key={cause}>{cause}</li>
                  ))}
                </ul>
              </div>
            )}
            <div className="ttd-dialog-output-error-message">
              {errorMessageLines.map((line, index) => (
                <span
                  key={`error-line-${index}`}
                  className={
                    isMermaidCaretLine(line)
                      ? "ttd-dialog-output-error-message__caret"
                      : undefined
                  }
                >
                  {line}
                  {index < errorMessageLines.length - 1 ? "\n" : ""}
                </span>
              ))}
            </div>
            {!hideErrorDetails && (
              <div className="ttd-dialog-output-error-autofix-slot">
                {showAutoFixButton ? (
                  <Button
                    className="ttd-dialog-panel-button ttd-dialog-output-error-autofix"
                    onSelect={onApplyAutoFix}
                  >
                    {t("mermaid.autoFixAvailable")}
                  </Button>
                ) : null}
              </div>
            )}
          </div>
        </div>
      )}
      {loaded ? (
        <div
          key="canvas"
          className={clsx("ttd-dialog-output-canvas-container", {
            invisible: !!error,
          })}
          aria-busy={loading}
        >
          <div
            ref={canvasRef}
            className="ttd-dialog-output-canvas-content"
            role={hasPreview && !loading ? "img" : undefined}
            aria-label={
              hasPreview && !loading ? canvasAriaLabel : undefined
            }
          />
          {loading && (
            <Spinner
              className="ttd-dialog-output-loading"
              size="2rem"
            />
          )}
          {!loading && !hasPreview && !error && (
            <div
              className="ttd-dialog-output-empty"
              role="status"
              aria-live="polite"
            >
              {emptyMessage}
            </div>
          )}
        </div>
      ) : (
        <Spinner size="2rem" />
      )}
    </div>
  );
};
