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

let editorAppLoadPromise: Promise<typeof import("./EditorApp")> | null = null;

const loadEditorApp = () => {
  if (!editorAppLoadPromise) {
    editorAppLoadPromise = import("./EditorApp");
  }
  return editorAppLoadPromise;
};
type EditorAppComponent = typeof import("./EditorApp").default;

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
  const [editorAppComponent, setEditorAppComponent] =
    useState<EditorAppComponent | null>(null);
  const navigationRequestRef = useRef(0);

  useEffect(() => {
    const handlePopState = () => {
      const nextUrl = window.location.href;
      const requestId = ++navigationRequestRef.current;
      if (!new URL(nextUrl).searchParams.has("id")) {
        startTransition(() => setCurrentUrl(nextUrl));
        return;
      }

      void loadEditorApp()
        .then((module) => {
          if (navigationRequestRef.current !== requestId) {
            return;
          }
          startTransition(() => {
            setEditorAppComponent(() => module.default);
            setCurrentUrl(nextUrl);
          });
        })
        .catch((error) => {
          console.error("加载编辑器失败", error);
        });
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  const location = new URL(currentUrl);
  const sceneId = location.searchParams.get("id");
  const shouldRenderWorkspaceHome = !sceneId;
  const EditorApp = editorAppComponent || LazyEditorApp;

  const navigateToScene = useCallback((targetSceneId: string) => {
    const requestId = ++navigationRequestRef.current;
    const url = new URL(window.location.href);
    url.search = `?id=${encodeURIComponent(targetSceneId)}`;
    url.hash = "";

    void loadEditorApp()
      .then((module) => {
        if (navigationRequestRef.current !== requestId) {
          return;
        }
        const nextUrl = `${url.pathname}${url.search}`;
        window.history.pushState(null, "", nextUrl);
        startTransition(() => {
          setEditorAppComponent(() => module.default);
          setCurrentUrl(nextUrl);
        });
      })
      .catch((error) => {
        console.error("加载编辑器失败", error);
      });
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
        ) : (
          <Suspense fallback={<EditorLoadingState />}>
            <EditorApp
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
