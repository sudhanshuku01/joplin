import * as React from 'react';
import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import TinyMCE from './NoteBody/TinyMCE/TinyMCE';
import { connect } from 'react-redux';
import MultiNoteActions from '../MultiNoteActions';
import { htmlToMarkdown, formNoteToNote } from './utils';
import useSearchMarkers from './utils/useSearchMarkers';
import useNoteSearchBar from './utils/useNoteSearchBar';
import useMessageHandler from './utils/useMessageHandler';
import useWindowCommandHandler from './utils/useWindowCommandHandler';
import useDropHandler from './utils/useDropHandler';
import useMarkupToHtml from './utils/useMarkupToHtml';
import useFormNote, { OnLoadEvent } from './utils/useFormNote';
import useEffectiveNoteId from './utils/useEffectiveNoteId';
import useFolder from './utils/useFolder';
import styles_ from './styles';
import { NoteEditorProps, FormNote, ScrollOptions, ScrollOptionTypes, OnChangeEvent, NoteBodyEditorProps, AllAssetsOptions, NoteBodyEditorRef } from './utils/types';
import ResourceEditWatcher from '@joplin/lib/services/ResourceEditWatcher/index';
import CommandService from '@joplin/lib/services/CommandService';
import ToolbarButton from '../ToolbarButton/ToolbarButton';
import Button, { ButtonLevel } from '../Button/Button';
import eventManager, { EventName } from '@joplin/lib/eventManager';
import { AppState } from '../../app.reducer';
import ToolbarButtonUtils from '@joplin/lib/services/commands/ToolbarButtonUtils';
import { _, _n } from '@joplin/lib/locale';
import TagList from '../TagList';
import NoteTitleBar from './NoteTitle/NoteTitleBar';
import markupLanguageUtils from '../../utils/markupLanguageUtils';
import usePrevious from '../hooks/usePrevious';
import Setting from '@joplin/lib/models/Setting';
import stateToWhenClauseContext from '../../services/commands/stateToWhenClauseContext';
import ExternalEditWatcher from '@joplin/lib/services/ExternalEditWatcher';
import { itemIsReadOnly } from '@joplin/lib/models/utils/readOnly';
const { themeStyle } = require('@joplin/lib/theme');
const { substrWithEllipsis } = require('@joplin/lib/string-utils');
import NoteSearchBar from '../NoteSearchBar';
import { reg } from '@joplin/lib/registry';
import Note from '@joplin/lib/models/Note';
import Folder from '@joplin/lib/models/Folder';
const bridge = require('@electron/remote').require('./bridge').default;
import NoteRevisionViewer from '../NoteRevisionViewer';
import { parseShareCache } from '@joplin/lib/services/share/reducer';
import useAsyncEffect from '@joplin/lib/hooks/useAsyncEffect';
import { ModelType } from '@joplin/lib/BaseModel';
import BaseItem from '@joplin/lib/models/BaseItem';
import { ErrorCode } from '@joplin/lib/errors';
import ItemChange from '@joplin/lib/models/ItemChange';
import PlainEditor from './NoteBody/PlainEditor/PlainEditor';
import CodeMirror6 from './NoteBody/CodeMirror/v6/CodeMirror';
import CodeMirror5 from './NoteBody/CodeMirror/v5/CodeMirror';
import { openItemById } from './utils/contextMenu';
import { namespacedKey } from '@joplin/lib/services/plugins/api/JoplinSettings';
import { MarkupLanguage } from '@joplin/renderer';

const commands = [
	require('./commands/showRevisions'),
];

const toolbarButtonUtils = new ToolbarButtonUtils(CommandService.instance());

function NoteEditor(props: NoteEditorProps) {
	const [showRevisions, setShowRevisions] = useState(false);
	const [titleHasBeenManuallyChanged, setTitleHasBeenManuallyChanged] = useState(false);
	const [scrollWhenReady, setScrollWhenReady] = useState<ScrollOptions>(null);
	const [isReadOnly, setIsReadOnly] = useState<boolean>(false);

	const editorRef = useRef<NoteBodyEditorRef>();
	const titleInputRef = useRef<any>();
	const isMountedRef = useRef(true);
	const noteSearchBarRef = useRef(null);

	const formNote_beforeLoad = useCallback(async (event: OnLoadEvent) => {
		await saveNoteIfWillChange(event.formNote);
		setShowRevisions(false);
		// eslint-disable-next-line @seiyab/react-hooks/exhaustive-deps -- Old code before rule was applied
	}, []);

	const formNote_afterLoad = useCallback(async () => {
		setTitleHasBeenManuallyChanged(false);
	}, []);

	const effectiveNoteId = useEffectiveNoteId(props);

	const { formNote, setFormNote, isNewNote, resourceInfos } = useFormNote({
		syncStarted: props.syncStarted,
		decryptionStarted: props.decryptionStarted,
		noteId: effectiveNoteId,
		isProvisional: props.isProvisional,
		titleInputRef: titleInputRef,
		editorRef: editorRef,
		onBeforeLoad: formNote_beforeLoad,
		onAfterLoad: formNote_afterLoad,
	});

	const formNoteRef = useRef<FormNote>();
	formNoteRef.current = { ...formNote };

	const formNoteFolder = useFolder({ folderId: formNote.parent_id });

	const {
		localSearch,
		onChange: localSearch_change,
		onNext: localSearch_next,
		onPrevious: localSearch_previous,
		onClose: localSearch_close,
		setResultCount: setLocalSearchResultCount,
		showLocalSearch,
		setShowLocalSearch,
		searchMarkers: localSearchMarkerOptions,
	} = useNoteSearchBar({ noteSearchBarRef });

	// If the note has been modified in another editor, wait for it to be saved
	// before loading it in this editor.
	// const waitingToSaveNote = props.noteId && formNote.id !== props.noteId && props.editorNoteStatuses[props.noteId] === 'saving';

	const styles = styles_(props);

	function scheduleSaveNote(formNote: FormNote) {
		if (!formNote.saveActionQueue) throw new Error('saveActionQueue is not set!!'); // Sanity check

		// reg.logger().debug('Scheduling...', formNote);

		const makeAction = (formNote: FormNote) => {
			return async function() {
				const note = await formNoteToNote(formNote);
				reg.logger().debug('Saving note...', note);
				const savedNote: any = await Note.save(note);

				setFormNote((prev: FormNote) => {
					return { ...prev, user_updated_time: savedNote.user_updated_time, hasChanged: false };
				});

				void ExternalEditWatcher.instance().updateNoteFile(savedNote);

				props.dispatch({
					type: 'EDITOR_NOTE_STATUS_REMOVE',
					id: formNote.id,
				});

				eventManager.emit(EventName.NoteContentChange, { note: savedNote });
			};
		};

		formNote.saveActionQueue.push(makeAction(formNote));
	}

	async function saveNoteIfWillChange(formNote: FormNote) {
		if (!formNote.id || !formNote.bodyWillChangeId) return;

		const body = await editorRef.current.content();

		scheduleSaveNote({
			...formNote,
			body: body,
			bodyWillChangeId: 0,
			bodyChangeId: 0,
		});
	}

	async function saveNoteAndWait(formNote: FormNote) {
		await saveNoteIfWillChange(formNote);
		return formNote.saveActionQueue.waitForAllDone();
	}

	const settingValue = useCallback((pluginId: string, key: string) => {
		return Setting.value(namespacedKey(pluginId, key));
	}, []);

	const whiteBackgroundNoteRendering = formNote.markup_language === MarkupLanguage.Html;

	const markupToHtml = useMarkupToHtml({
		themeId: props.themeId,
		whiteBackgroundNoteRendering,
		customCss: props.customCss,
		plugins: props.plugins,
		settingValue,
	});

	const allAssets = useCallback(async (markupLanguage: number, options: AllAssetsOptions = null): Promise<any[]> => {
		options = {
			contentMaxWidthTarget: '',
			...options,
		};

		const theme = themeStyle(options.themeId ? options.themeId : props.themeId);

		const markupToHtml = markupLanguageUtils.newMarkupToHtml({}, {
			resourceBaseUrl: `file://${Setting.value('resourceDir')}/`,
			customCss: props.customCss,
		});

		return markupToHtml.allAssets(markupLanguage, theme, {
			contentMaxWidth: props.contentMaxWidth,
			contentMaxWidthTarget: options.contentMaxWidthTarget,
			whiteBackgroundNoteRendering: options.whiteBackgroundNoteRendering,
		});
	}, [props.themeId, props.customCss, props.contentMaxWidth]);

	const handleProvisionalFlag = useCallback(() => {
		if (props.isProvisional) {
			props.dispatch({
				type: 'NOTE_PROVISIONAL_FLAG_CLEAR',
				id: formNote.id,
			});
		}
		// eslint-disable-next-line @seiyab/react-hooks/exhaustive-deps -- Old code before rule was applied
	}, [props.isProvisional, formNote.id]);

	const previousNoteId = usePrevious(formNote.id);

	useEffect(() => {
		if (formNote.id === previousNoteId) return;

		if (editorRef.current) {
			editorRef.current.resetScroll();
		}

		setScrollWhenReady({
			type: props.selectedNoteHash ? ScrollOptionTypes.Hash : ScrollOptionTypes.Percent,
			value: props.selectedNoteHash ? props.selectedNoteHash : props.lastEditorScrollPercents[formNote.id] || 0,
		});

		void ResourceEditWatcher.instance().stopWatchingAll();
		// eslint-disable-next-line @seiyab/react-hooks/exhaustive-deps -- Old code before rule was applied
	}, [formNote.id, previousNoteId]);

	const onFieldChange = useCallback((field: string, value: any, changeId = 0) => {
		if (!isMountedRef.current) {
			// When the component is unmounted, various actions can happen which can
			// trigger onChange events, for example the textarea might be cleared.
			// We need to ignore these events, otherwise the note is going to be saved
			// with an invalid body.
			reg.logger().debug('Skipping change event because the component is unmounted');
			return;
		}

		handleProvisionalFlag();

		const change = field === 'body' ? {
			body: value,
		} : {
			title: value,
		};

		const newNote = {
			...formNote,
			...change,
			bodyWillChangeId: 0,
			bodyChangeId: 0,
			hasChanged: true,
		};

		if (field === 'title') {
			setTitleHasBeenManuallyChanged(true);
		}

		if (isNewNote && !titleHasBeenManuallyChanged && field === 'body') {
			// TODO: Handle HTML/Markdown format
			newNote.title = Note.defaultTitle(value);
		}

		if (changeId !== null && field === 'body' && formNote.bodyWillChangeId !== changeId) {
			// Note was changed, but another note was loaded before save - skipping
			// The previously loaded note, that was modified, will be saved via saveNoteIfWillChange()
		} else {
			setFormNote(newNote);
			scheduleSaveNote(newNote);
		}
		// eslint-disable-next-line @seiyab/react-hooks/exhaustive-deps -- Old code before rule was applied
	}, [handleProvisionalFlag, formNote, isNewNote, titleHasBeenManuallyChanged]);

	useWindowCommandHandler({
		dispatch: props.dispatch,
		formNote,
		setShowLocalSearch,
		noteSearchBarRef,
		editorRef,
		titleInputRef,
		saveNoteAndWait,
		setFormNote,
	});

	const onDrop = useDropHandler({ editorRef });

	const onBodyChange = useCallback((event: OnChangeEvent) => onFieldChange('body', event.content, event.changeId), [onFieldChange]);

	const onTitleChange = useCallback((event: any) => onFieldChange('title', event.target.value), [onFieldChange]);

	// const onTitleKeydown = useCallback((event:any) => {
	// 	const keyCode = event.keyCode;

	// 	if (keyCode === 9) {
	// 		// TAB
	// 		event.preventDefault();

	// 		if (event.shiftKey) {
	// 			CommandService.instance().execute('focusElement', 'noteList');
	// 		} else {
	// 			CommandService.instance().execute('focusElement', 'noteBody');
	// 		}
	// 	}
	// }, [props.dispatch]);

	const shareCache = useMemo(() => {
		return parseShareCache(props.shareCacheSetting);
	}, [props.shareCacheSetting]);

	useAsyncEffect(async event => {
		if (!formNote.id) return;

		try {
			const result = await itemIsReadOnly(BaseItem, ModelType.Note, ItemChange.SOURCE_UNSPECIFIED, formNote.id, props.syncUserId, shareCache);
			if (event.cancelled) return;
			setIsReadOnly(result);
		} catch (error) {
			if (error.code === ErrorCode.NotFound) {
				// Can happen if the note has been deleted but a render is
				// triggered anyway. It can be ignored.
			} else {
				throw error;
			}
		}
	}, [formNote.id, props.syncUserId, shareCache]);

	const onBodyWillChange = useCallback((event: any) => {
		handleProvisionalFlag();

		setFormNote(prev => {
			return {
				...prev,
				bodyWillChangeId: event.changeId,
				hasChanged: true,
			};
		});

		props.dispatch({
			type: 'EDITOR_NOTE_STATUS_SET',
			id: formNote.id,
			status: 'saving',
		});
		// eslint-disable-next-line @seiyab/react-hooks/exhaustive-deps -- Old code before rule was applied
	}, [formNote, handleProvisionalFlag]);

	const onMessage = useMessageHandler(scrollWhenReady, setScrollWhenReady, editorRef, setLocalSearchResultCount, props.dispatch, formNote, htmlToMarkdown, markupToHtml);

	const externalEditWatcher_noteChange = useCallback((event: any) => {
		if (event.id === formNote.id) {
			const newFormNote = {
				...formNote,
				title: event.note.title,
				body: event.note.body,
			};

			setFormNote(newFormNote);
		}
		// eslint-disable-next-line @seiyab/react-hooks/exhaustive-deps -- Old code before rule was applied
	}, [formNote]);

	const onNotePropertyChange = useCallback((event: any) => {
		setFormNote(formNote => {
			if (formNote.id !== event.note.id) return formNote;

			const newFormNote: FormNote = { ...formNote };

			for (const key in event.note) {
				if (key === 'id') continue;
				(newFormNote as any)[key] = event.note[key];
			}

			return newFormNote;
		});
		// eslint-disable-next-line @seiyab/react-hooks/exhaustive-deps -- Old code before rule was applied
	}, []);

	useEffect(() => {
		eventManager.on(EventName.AlarmChange, onNotePropertyChange);
		ExternalEditWatcher.instance().on('noteChange', externalEditWatcher_noteChange);

		return () => {
			eventManager.off(EventName.AlarmChange, onNotePropertyChange);
			ExternalEditWatcher.instance().off('noteChange', externalEditWatcher_noteChange);
		};
	}, [externalEditWatcher_noteChange, onNotePropertyChange]);

	useEffect(() => {
		const dependencies = {
			setShowRevisions,
		};

		CommandService.instance().componentRegisterCommands(dependencies, commands);

		return () => {
			CommandService.instance().componentUnregisterCommands(commands);
		};
	}, [setShowRevisions]);

	const onScroll = useCallback((event: { percent: number }) => {
		props.dispatch({
			type: 'EDITOR_SCROLL_PERCENT_SET',
			// In callbacks of setTimeout()/setInterval(), props/state cannot be used
			// to refer the current value, since they would be one or more generations old.
			// For the purpose, useRef value should be used.
			noteId: formNoteRef.current.id,
			percent: event.percent,
		});
	}, [props.dispatch]);

	function renderNoNotes(rootStyle: any) {
		const emptyDivStyle = {
			backgroundColor: 'black',
			opacity: 0.1,
			...rootStyle,
		};
		return <div style={emptyDivStyle}></div>;
	}

	function renderTagButton() {
		return <ToolbarButton
			themeId={props.themeId}
			toolbarButtonInfo={props.setTagsToolbarButtonInfo}
		/>;
	}

	function renderTagBar() {
		const theme = themeStyle(props.themeId);
		const noteIds = [formNote.id];
		const instructions = <span onClick={() => { void CommandService.instance().execute('setTags', noteIds); }} style={{ ...theme.clickableTextStyle, whiteSpace: 'nowrap' }}>{_('Click to add tags...')}</span>;
		const tagList = props.selectedNoteTags.length ? <TagList items={props.selectedNoteTags} /> : null;

		return (
			<div style={{ paddingLeft: 8, display: 'flex', flexDirection: 'row', alignItems: 'center' }}>{tagList}{instructions}</div>
		);
	}

	const searchMarkers = useSearchMarkers(showLocalSearch, localSearchMarkerOptions, props.searches, props.selectedSearchId, props.highlightedWords);

	const editorProps: NoteBodyEditorProps = {
		ref: editorRef,
		contentKey: formNote.id,
		style: styles.tinyMCE,
		whiteBackgroundNoteRendering,
		onChange: onBodyChange,
		onWillChange: onBodyWillChange,
		onMessage: onMessage,
		content: formNote.body,
		contentMarkupLanguage: formNote.markup_language,
		contentOriginalCss: formNote.originalCss,
		resourceInfos: resourceInfos,
		resourceDirectory: Setting.value('resourceDir'),
		htmlToMarkdown: htmlToMarkdown,
		markupToHtml: markupToHtml,
		allAssets: allAssets,
		disabled: isReadOnly,
		themeId: props.themeId,
		dispatch: props.dispatch,
		noteToolbar: null,
		onScroll: onScroll,
		setLocalSearchResultCount: setLocalSearchResultCount,
		searchMarkers: searchMarkers,
		visiblePanes: props.noteVisiblePanes || ['editor', 'viewer'],
		keyboardMode: Setting.value('editor.keyboardMode'),
		locale: Setting.value('locale'),
		onDrop: onDrop,
		noteToolbarButtonInfos: props.toolbarButtonInfos,
		plugins: props.plugins,
		fontSize: Setting.value('style.editor.fontSize'),
		fontFamily: Setting.value('style.editor.fontFamily'),
		contentMaxWidth: props.contentMaxWidth,
		isSafeMode: props.isSafeMode,
		useCustomPdfViewer: props.useCustomPdfViewer,
		// We need it to identify the context for which media is rendered.
		// It is currently used to remember pdf scroll position for each attachments of each note uniquely.
		noteId: props.noteId,
	};

	let editor = null;

	if (props.bodyEditor === 'TinyMCE') {
		editor = <TinyMCE {...editorProps}/>;
	} else if (props.bodyEditor === 'PlainText') {
		editor = <PlainEditor {...editorProps}/>;
	} else if (props.bodyEditor === 'CodeMirror') {
		editor = <CodeMirror5 {...editorProps}/>;
	} else if (props.bodyEditor === 'CodeMirror6') {
		editor = <CodeMirror6 {...editorProps}/>;
	} else {
		throw new Error(`Invalid editor: ${props.bodyEditor}`);
	}

	const onRichTextReadMoreLinkClick = useCallback(() => {
		bridge().openExternal('https://joplinapp.org/help/apps/rich_text_editor');
	}, []);

	const onRichTextDismissLinkClick = useCallback(() => {
		Setting.setValue('richTextBannerDismissed', true);
	}, []);

	const wysiwygBanner = props.bodyEditor !== 'TinyMCE' || props.richTextBannerDismissed ? null : (
		<div style={styles.warningBanner}>
			{_('This Rich Text editor has a number of limitations and it is recommended to be aware of them before using it.')}
			&nbsp;&nbsp;<a onClick={onRichTextReadMoreLinkClick} style={styles.warningBannerLink} href="#">[ {_('Read more about it')} ]</a>
			&nbsp;&nbsp;<a onClick={onRichTextDismissLinkClick} style={styles.warningBannerLink} href="#">[ {_('Dismiss')} ]</a>
		</div>
	);

	const noteRevisionViewer_onBack = useCallback(() => {
		setShowRevisions(false);
	}, []);

	const onBannerResourceClick = useCallback(async (event: React.MouseEvent<HTMLAnchorElement>) => {
		event.preventDefault();
		const resourceId = event.currentTarget.getAttribute('data-resource-id');
		await openItemById(resourceId, props.dispatch);
	}, [props.dispatch]);

	if (showRevisions) {
		const theme = themeStyle(props.themeId);

		const revStyle: any = {
			// ...props.style,
			display: 'inline-flex',
			padding: theme.margin,
			verticalAlign: 'top',
			boxSizing: 'border-box',
		};

		return (
			<div style={revStyle}>
				<NoteRevisionViewer customCss={props.customCss} noteId={formNote.id} onBack={noteRevisionViewer_onBack} />
			</div>
		);
	}

	if (props.selectedNoteIds.length > 1) {
		return <MultiNoteActions
			themeId={props.themeId}
			selectedNoteIds={props.selectedNoteIds}
			notes={props.notes}
			dispatch={props.dispatch}
			watchedNoteFiles={props.watchedNoteFiles}
			plugins={props.plugins}
			inConflictFolder={props.selectedFolderId === Folder.conflictFolderId()}
			customCss={props.customCss}
		/>;
	}

	function renderSearchBar() {
		if (!showLocalSearch) return false;

		const theme = themeStyle(props.themeId);

		return (
			<NoteSearchBar
				ref={noteSearchBarRef}
				themeId={props.themeId}
				style={{
					display: 'flex',
					height: 35,
					borderTop: `1px solid ${theme.dividerColor}`,
				}}
				query={localSearch.query}
				searching={localSearch.searching}
				resultCount={localSearch.resultCount}
				selectedIndex={localSearch.selectedIndex}
				onChange={localSearch_change}
				onNext={localSearch_next}
				onPrevious={localSearch_previous}
				onClose={localSearch_close}
				visiblePanes={props.noteVisiblePanes}
			/>
		);
	}

	function renderResourceWatchingNotification() {
		if (!Object.keys(props.watchedResources).length) return null;
		const resourceTitles = Object.keys(props.watchedResources).map(id => props.watchedResources[id].title);
		return (
			<div style={styles.resourceWatchBanner}>
				<p style={styles.resourceWatchBannerLine}>{_('The following attachments are being watched for changes:')} <strong>{resourceTitles.join(', ')}</strong></p>
				<p style={{ ...styles.resourceWatchBannerLine, marginBottom: 0 }}>{_('The attachments will no longer be watched when you switch to a different note.')}</p>
			</div>
		);
	}

	const renderResourceInSearchResultsNotification = () => {
		const resourceResults = props.searchResults.filter(r => r.id === props.noteId && r.item_type === ModelType.Resource);
		if (!resourceResults.length) return null;

		const renderResource = (id: string, title: string) => {
			return <li key={id}><a data-resource-id={id} onClick={onBannerResourceClick} href="#">{title}</a></li>;
		};

		return (
			<div style={styles.resourceWatchBanner}>
				<p style={styles.resourceWatchBannerLine}>{_n('The following attachment matches your search query:', 'The following attachments match your search query:', resourceResults.length)}</p>
				<ul>
					{resourceResults.map(r => renderResource(r.item_id, r.title))}
				</ul>
			</div>
		);
	};

	function renderSearchInfo() {
		const theme = themeStyle(props.themeId);
		if (formNoteFolder && ['Search', 'Tag', 'SmartFilter'].includes(props.notesParentType)) {
			return (
				<div style={{ paddingTop: 10, paddingBottom: 10, paddingLeft: theme.editorPaddingLeft }}>
					<Button
						iconName="icon-notebooks"
						level={ButtonLevel.Primary}
						title={_('In: %s', substrWithEllipsis(formNoteFolder.title, 0, 100))}
						onClick={() => {
							props.dispatch({
								type: 'FOLDER_AND_NOTE_SELECT',
								folderId: formNoteFolder.id,
								noteId: formNote.id,
							});
						}}
					/>
					<div style={{ flex: 1 }}></div>
				</div>
			);
		} else {
			return null;
		}
	}

	if (formNote.encryption_applied || !formNote.id || !effectiveNoteId) {
		return renderNoNotes(styles.root);
	}

	const theme = themeStyle(props.themeId);

	return (
		<div style={styles.root} onDrop={onDrop}>
			<div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
				{renderResourceWatchingNotification()}
				{renderResourceInSearchResultsNotification()}
				<NoteTitleBar
					titleInputRef={titleInputRef}
					themeId={props.themeId}
					isProvisional={props.isProvisional}
					noteIsTodo={formNote.is_todo}
					noteTitle={formNote.title}
					noteUserUpdatedTime={formNote.user_updated_time}
					onTitleChange={onTitleChange}
					disabled={isReadOnly}
				/>
				{renderSearchInfo()}
				<div style={{ display: 'flex', flex: 1, paddingLeft: theme.editorPaddingLeft, maxHeight: '100%', minHeight: '0' }}>
					{editor}
				</div>
				<div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center' }}>
					{renderSearchBar()}
				</div>
				<div className="tag-bar" style={{ paddingLeft: theme.editorPaddingLeft, display: 'flex', flexDirection: 'row', alignItems: 'center', height: 40 }}>
					{renderTagButton()}
					{renderTagBar()}
				</div>
				{wysiwygBanner}
			</div>
		</div>
	);
}

export {
	NoteEditor as NoteEditorComponent,
};

const mapStateToProps = (state: AppState) => {
	const noteId = state.selectedNoteIds.length === 1 ? state.selectedNoteIds[0] : null;
	const whenClauseContext = stateToWhenClauseContext(state);

	return {
		noteId: noteId,
		notes: state.notes,
		selectedNoteIds: state.selectedNoteIds,
		selectedFolderId: state.selectedFolderId,
		isProvisional: state.provisionalNoteIds.includes(noteId),
		editorNoteStatuses: state.editorNoteStatuses,
		syncStarted: state.syncStarted,
		decryptionStarted: state.decryptionWorker?.state !== 'idle',
		themeId: state.settings.theme,
		richTextBannerDismissed: state.settings.richTextBannerDismissed,
		watchedNoteFiles: state.watchedNoteFiles,
		notesParentType: state.notesParentType,
		selectedNoteTags: state.selectedNoteTags,
		lastEditorScrollPercents: state.lastEditorScrollPercents,
		selectedNoteHash: state.selectedNoteHash,
		searches: state.searches,
		selectedSearchId: state.selectedSearchId,
		customCss: state.customCss,
		noteVisiblePanes: state.noteVisiblePanes,
		watchedResources: state.watchedResources,
		highlightedWords: state.highlightedWords,
		plugins: state.pluginService.plugins,
		toolbarButtonInfos: toolbarButtonUtils.commandsToToolbarButtons([
			'historyBackward',
			'historyForward',
			'toggleEditors',
			'toggleExternalEditing',
		], whenClauseContext),
		setTagsToolbarButtonInfo: toolbarButtonUtils.commandsToToolbarButtons([
			'setTags',
		], whenClauseContext)[0],
		contentMaxWidth: state.settings['style.editor.contentMaxWidth'],
		isSafeMode: state.settings.isSafeMode,
		useCustomPdfViewer: false,
		syncUserId: state.settings['sync.userId'],
		shareCacheSetting: state.settings['sync.shareCache'],
		searchResults: state.searchResults,
	};
};

export default connect(mapStateToProps)(NoteEditor);
