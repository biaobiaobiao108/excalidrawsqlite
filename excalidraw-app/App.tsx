import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useState,
} from "react";

import { Provider, appJotaiStore } from "./app-jotai";
import { WorkspaceHome } from "./components/WorkspaceHome";
import { TopErrorBoundary } from "./components/TopErrorBoundary";

const LazyEditorApp = lazy(() => import("./EditorApp"));

const EditorLoadingState = () => (
  <div
    style={{
      alignItems: "center",
      display: "flex",
      height: "100%",
      justifyContent: "center",
    }}
    role="status"
  >
    正在加载编辑器...
  </div>
);

const ExcalidrawApp = () => {
  const [currentUrl, setCurrentUrl] = useState(() => window.location.href);

  useEffect(() => {
    const handlePopState = () => {
      setCurrentUrl(window.location.href);
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  const location = new URL(currentUrl);
  const sceneId = location.searchParams.get("id");
  const shouldRenderWorkspaceHome = !sceneId;

  const navigateToScene = useCallback((targetSceneId: string) => {
    const url = new URL(window.location.href);
    url.search = `?id=${encodeURIComponent(targetSceneId)}`;
    url.hash = "";
    window.history.pushState(null, "", `${url.pathname}${url.search}`);
    setCurrentUrl(window.location.href);
  }, []);

  const navigateToWorkspace = useCallback(() => {
    const url = new URL(window.location.href);
    url.search = "";
    url.hash = "";
    window.history.pushState(null, "", `${url.pathname}`);
    setCurrentUrl(window.location.href);
  }, []);

  return (
    <TopErrorBoundary>
      <Provider store={appJotaiStore}>
        {shouldRenderWorkspaceHome ? (
          <WorkspaceHome onSelectScene={navigateToScene} />
        ) : (
          <Suspense fallback={<EditorLoadingState />}>
            <LazyEditorApp
              key={sceneId || currentUrl}
              onNavigateHome={navigateToWorkspace}
            />
          </Suspense>
        )}
      </Provider>
    </TopErrorBoundary>
  );
};

export default ExcalidrawApp;
