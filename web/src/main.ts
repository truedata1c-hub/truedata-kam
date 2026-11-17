import { createApp } from 'vue';
import { Quasar, Notify, Dialog } from 'quasar';
import langRu from 'quasar/lang/ru';
import '@quasar/extras/material-icons/material-icons.css';
import 'quasar/dist/quasar.css';
import './theme.css';
import './kam.css';
import App from './App.vue';

createApp(App)
  .use(Quasar, {
    plugins: { Notify, Dialog },
    lang: langRu,
    config: {
      brand: { primary: '#6941c6', secondary: '#344054', accent: '#be7b2f', positive: '#427a48', negative: '#b13a4d', warning: '#be7b2f', info: '#344054', dark: '#101828' },
      notify: { position: 'top-right', timeout: 3500 },
    },
  })
  .mount('#app');
