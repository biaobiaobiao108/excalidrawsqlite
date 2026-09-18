import {
  lazy,
  startTransition,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import "./app-pwa";
import { Provider, appJotaiStore } from "./app-jotai";
import { WorkspaceHome } from "./components/WorkspaceHome";
import { TopErrorBoundary } from "./components/TopErrorBoundary";

const loadEditorApp = () => import("./EditorApp");
const LazyEditorApp = lazy(loadEditorApp);

const preloadEditorApp = () => {
  void loadEditorApp();
};

const EditorLoadingState = () => (
  <div
    className="editor-loading-state"
    role="status"
  >
    正在加载编辑器...
  </div>
);

const ExcalidrawApp = () => {
  const [currentUrl, setCurrentUrl] = useState(() => window.location.href);
  const navigationRequestRef = useRef(0);

  useEffect(() => {
    const handlePopState = () => {
      const nextUrl = window.location.href;
      if (new URL(nextUrl).searchParams.has("id")) {
        preloadEditorApp();
      }
      startTransition(() => setCurrentUrl(nextUrl));
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  const location = new URL(currentUrl);
  const sceneId = location.searchParams.get("id");
  const shouldRenderWorkspaceHome = !sceneId;

  const navigateToScene = useCallback((targetSceneId: string) => {
    const requestId = ++navigationRequestRef.current;
    const url = new URL(window.location.href);
    url.search = `?id=${encodeURIComponent(targetSceneId)}`;
    url.hash = "";

    void loadEditorApp()
      .then(() => {
        if (navigationRequestRef.current !== requestId) {
          return;
        }
        window.history.pushState(null, "", `${url.pathname}${url.search}`);
        startTransition(() => setCurrentUrl(window.location.href));
      })
      .catch((error) => {
        console.error("加载编辑器失败", error);
      });
  }, []);

  const navigateToWorkspace = useCallback(() => {
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
