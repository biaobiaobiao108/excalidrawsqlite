import { FONT_FAMILY } from "@excalidraw/common";
import { Fonts, WelcomeScreen } from "@excalidraw/excalidraw/index";
import { useI18n } from "@excalidraw/excalidraw/i18n";
import { newTextElement } from "@excalidraw/element";
import React, { useEffect } from "react";

export const AppWelcomeScreen: React.FC = React.memo(() => {
  const { t } = useI18n();
  const headingText = [
    t("welcomeScreen.app.cloud_heading"),
    t("welcomeScreen.app.cloud_heading_line2"),
    t("welcomeScreen.app.cloud_heading_line3"),
  ].join("\n");

  useEffect(() => {
    const fontProbe = newTextElement({
      text: headingText,
      x: 0,
      y: 0,
      fontFamily: FONT_FAMILY.Excalifont,
    });

    void Fonts.loadElementsFonts([fontProbe]);
  }, [headingText]);

  const headingContent = (
    <>
      {t("welcomeScreen.app.cloud_heading")}
      <br />
      {t("welcomeScreen.app.cloud_heading_line2")}
      <br />
      {t("welcomeScreen.app.cloud_heading_line3")}
    </>
  );

  return (
    <WelcomeScreen>
      <WelcomeScreen.Hints.MenuHint>
        {t("welcomeScreen.app.menuHint")}
      </WelcomeScreen.Hints.MenuHint>
      <WelcomeScreen.Hints.ToolbarHint />
      <WelcomeScreen.Hints.HelpHint />
      <WelcomeScreen.Center>
        <WelcomeScreen.Center.Logo />
        <WelcomeScreen.Center.Heading>
          {headingContent}
        </WelcomeScreen.Center.Heading>
        <WelcomeScreen.Center.Menu>
          <WelcomeScreen.Center.MenuItemLoadScene />
          <WelcomeScreen.Center.MenuItemHelp />
        </WelcomeScreen.Center.Menu>
      </WelcomeScreen.Center>
    </WelcomeScreen>
  );
});
