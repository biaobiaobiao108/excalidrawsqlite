import {
  startTransition,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import "./app-pwa";
import { Provider, appJotaiStore } from "./app-jotai";
import { WorkspaceHome } from "./components/WorkspaceHome";
import { TopErrorBoundary } from "./components/TopErrorBoundary";
import { loadEditorApp } from "./editorAppLoader";

type EditorAppComponent = typeof import("./EditorApp").default;

const preloadEditorApp = () => {
  void loadEditorApp().catch((error) => {
    console.warn("预加载编辑器失败", error);
  });
};

const EditorLoadingState = ({
  error,
  onRetry,
}: {
  error: string | null;
  onRetry: () => void;
}) => (
  <div className="editor-loading-state" role={error ? "alert" : "status"}>
    {error ? (
      <>
        <p>{error}</p>
        <button type="button" onClick={onRetry}>
          重试
        </button>
      </>
    ) : (
      "正在加载编辑器..."
    )}
  </div>
);

const ExcalidrawApp = () => {
  const [currentUrl, setCurrentUrl] = useState(() => window.location.href);
  const [editorAppComponent, setEditorAppComponent] =
    useState<EditorAppComponent | null>(null);
  const [editorLoadError, setEditorLoadError] = useState<string | null>(null);
  const [editorLoadAttempt, setEditorLoadAttempt] = useState(0);
  const navigationRequestRef = useRef(0);

  useEffect(() => {
    const handlePopState = () => {
      const nextUrl = window.location.href;
      navigationRequestRef.current += 1;
      startTransition(() => setCurrentUrl(nextUrl));
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  const location = new URL(currentUrl);
  const sceneId = location.searchParams.get("id");
  const shouldRenderWorkspaceHome = !sceneId;
  const EditorApp = editorAppComponent;

  useEffect(() => {
    if (!sceneId || editorAppComponent) {
      return;
    }

    const requestId = ++navigationRequestRef.current;
    setEditorLoadError(null);
    void loadEditorApp()
      .then((module) => {
        if (navigationRequestRef.current !== requestId) {
          return;
        }
        setEditorAppComponent(() => module.default);
      })
      .catch((error) => {
        if (navigationRequestRef.current !== requestId) {
          return;
        }
        console.error("加载编辑器失败", error);
        setEditorLoadError("编辑器加载失败，请检查网络后重试。");
      });

    return () => {
      if (navigationRequestRef.current === requestId) {
        navigationRequestRef.current += 1;
      }
    };
  }, [currentUrl, editorAppComponent, editorLoadAttempt, sceneId]);

  const navigateToScene = useCallback((targetSceneId: string) => {
    const url = new URL(window.location.href);
    url.search = `?id=${encodeURIComponent(targetSceneId)}`;
    url.hash = "";
    window.history.pushState(null, "", `${url.pathname}${url.search}`);
    startTransition(() => setCurrentUrl(url.href));
  }, []);

  const navigateToWorkspace = useCallback(() => {
    navigationRequestRef.current += 1;
    const url = new URL(window.location.href);
    url.search = "";
    url.hash = "";
    window.history.pushState(null, "", `${url.pathname}`);
    startTransition(() => setCurrentUrl(window.location.href));
  }, []);

  return (
    <TopErrorBoundary>
      <Provider store={appJotaiStore}>
        {shouldRenderWorkspaceHome ? (
          <WorkspaceHome
            onSelectScene={navigateToScene}
            onPreloadScene={preloadEditorApp}
          />
        ) : EditorApp ? (
          <EditorApp
            key={sceneId || currentUrl}
            onNavigateHome={navigateToWorkspace}
          />
        ) : (
          <EditorLoadingState
            error={editorLoadError}
            onRetry={() => setEditorLoadAttempt((attempt) => attempt + 1)}
          />
        )}
      </Provider>
    </TopErrorBoundary>
  );
};

export default ExcalidrawApp;
