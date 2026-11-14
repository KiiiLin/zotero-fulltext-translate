import { config } from "../../package.json";
import { getPref } from "../utils/prefs";
import {
  canTranslateFullText,
  hasFullTextJob,
  pauseFullTextTranslation,
  enqueueFullTextTranslations,
} from "./fulltext";
import {
  addTranslateAbstractTask,
  addTranslateTitleTask,
  TranslateTask,
} from "../utils/task";

export function registerMenu() {
  const menuIcon = `chrome://${config.addonRef}/content/icons/favicon.png`;

  Zotero.MenuManager.registerMenu({
    menuID: `${config.addonRef}-translate-title`,
    pluginID: config.addonID,
    target: "main/library/item",
    menus: [
      {
        menuType: "menuitem",
        l10nID: `${config.addonRef}-itemmenu-translateFullText`,
        icon: menuIcon,
        onCommand: (_event, context) => {
          if (context.items?.length)
            void enqueueFullTextTranslations(context.items);
        },
        onShowing: (_event, context) => {
          const items = (context.items || []).filter(canTranslateFullText);
          context.setVisible(items.length > 0);
          context.setEnabled(
            items.some((item) => item.isEditable() && !hasFullTextJob(item)),
          );
        },
      },
      {
        menuType: "menuitem",
        l10nID: `${config.addonRef}-itemmenu-pauseFullText`,
        onCommand: (_event, context) => {
          for (const item of context.items || [])
            void pauseFullTextTranslation(item);
        },
        onShowing: (_event, context) => {
          context.setVisible(!!context.items?.some(hasFullTextJob));
        },
      },
      {
        menuType: "menuitem",
        l10nID: `${config.addonRef}-itemmenu-translateTitle`,
        icon: menuIcon,
        onCommand: (event, context) => {
          if (!context.items?.length) {
            return;
          }
          addon.hooks.onTranslateInBatch(
            context.items
              .map((item) => addTranslateTitleTask(item.id, true))
              .filter((task) => task) as TranslateTask[],
            { noDisplay: true, noCache: true },
          );
        },
        onShowing: (event, context) => {
          context.setVisible(
            !!(
              getPref("showItemMenuTitleTranslation") &&
              context.items?.every((item) => item.isRegularItem())
            ),
          );
        },
      },
      {
        menuType: "menuitem",
        l10nID: `${config.addonRef}-itemmenu-translateAbstract`,
        icon: menuIcon,
        onCommand: (event, context) => {
          if (!context.items?.length) {
            return;
          }
          addon.hooks.onTranslateInBatch(
            context.items
              .map((item) => addTranslateAbstractTask(item.id, true))
              .filter((task) => task) as TranslateTask[],
            { noDisplay: true, noCache: true },
          );
        },
        onShowing: (event, context) => {
          context.setVisible(
            !!(
              getPref("showItemMenuAbstractTranslation") &&
              context.items?.every((item) => item.isRegularItem())
            ),
          );
        },
      },
    ],
  });
}
