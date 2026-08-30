import { Excalidraw, MainMenu } from "@excalidraw/excalidraw";
import { defaultLang, languages } from "@excalidraw/excalidraw/i18n";
import { UI } from "@excalidraw/excalidraw/tests/helpers/ui";
import {
  screen,
  fireEvent,
  waitFor,
  render,
} from "@excalidraw/excalidraw/tests/test-utils";

import { LanguageList } from "../app-language/LanguageList";
import { useAppLangCode } from "../app-language/language-state";
import { Provider } from "../app-jotai";

const TEST_LANG_CODE = "fr-FR";

const TestApp = () => {
  const [langCode] = useAppLangCode();

  return (
    <Excalidraw langCode={langCode}>
      <MainMenu>
        <MainMenu.ItemCustom>
          <LanguageList />
        </MainMenu.ItemCustom>
      </MainMenu>
    </Excalidraw>
  );
};

describe("Test LanguageList", () => {
  it("rerenders UI on language change", async () => {
    expect(languages.some((lang) => lang.code === TEST_LANG_CODE)).toBe(true);

    await render(
      <Provider>
        <TestApp />
      </Provider>,
    );

    // select rectangle tool to show properties menu
    UI.clickTool("rectangle");
    // english lang should display `thin` label
    expect(screen.queryByTitle(/thin/i)).not.toBeNull();
    fireEvent.click(document.querySelector(".dropdown-menu-button")!);

    const languageTrigger = screen.getByRole("button", {
      name: /select language|选择语言/i,
    });
    fireEvent.click(languageTrigger);
    fireEvent.click(
      screen.getByRole("option", {
        name: languages.find((language) => language.code === TEST_LANG_CODE)
          ?.label,
      }),
    );
    // switching to French, `thin` label should no longer exist
    await waitFor(() => expect(screen.queryByTitle(/thin/i)).toBeNull());
    fireEvent.click(languageTrigger);
    fireEvent.click(
      screen.getByRole("option", {
        name: languages.find((language) => language.code === "zh-CN")?.label,
      }),
    );
    await waitFor(() => {
      expect(document.documentElement.lang).toBe("zh-CN");
      expect(localStorage.getItem("i18nextLng")).toBe("zh-CN");
    });
    // reset language
    fireEvent.click(languageTrigger);
    fireEvent.click(
      screen.getByRole("option", {
        name: languages.find((language) => language.code === defaultLang.code)
          ?.label,
      }),
    );
    // switching back to English
    await waitFor(() => expect(screen.queryByTitle(/thin/i)).not.toBeNull());
  });
});
