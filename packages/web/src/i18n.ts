import NextI18Next, { I18n, TFunction } from 'next-i18next'

const options = { defaultLanguage: 'en', otherLanguages: ['en'], saveMissing: false }
const NextI18NextInstance = new NextI18Next(options)
export const Trans = NextI18NextInstance.Trans

export interface I18nProps {
  t: TFunction
  i18n: I18n
  tReady: boolean
}

export default NextI18NextInstance
export const { appWithTranslation, withTranslation } = NextI18NextInstance
export const withNamespaces = withTranslation
export const useTranslation = NextI18NextInstance.useTranslation

export enum NameSpaces {
  common = 'common',
  alliance = 'alliance',
  about = 'about',
  applications = 'applications',
  brand = 'brand',
  cambio = 'cambio',
  codeofconduct = 'codeofconduct',
  community = 'community',
  download = 'download',
  dev = 'dev',
  faucet = 'faucet',
  home = 'home',
  jobs = 'jobs',
  papers = 'papers',
  terms = 'terms',
  technology = 'technology',
}
